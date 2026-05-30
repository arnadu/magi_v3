#!/usr/bin/env python3
"""
Stage 2: read per-call CSV from stdin, print two tables.

Table 1 — per-agent token statistics (calls, cache hit rate, cost, …)
Table 2 — per-tool context impact (avg ctx delta, estimated cost, …)

Usage:
  MISSION_ID=xyz MONGODB_URI=... npm run cli:analyze -w packages/agent-runtime-worker
  … | python3 scripts/analyze-tokens.py
  … | python3 scripts/analyze-tokens.py --csv
"""

import csv
import sys
import collections
from datetime import datetime, timezone


# ---------------------------------------------------------------------------
# CSV input
# ---------------------------------------------------------------------------

def load_rows(fp):
    reader = csv.DictReader(fp)
    rows = []
    for r in reader:
        rows.append({
            "agent_id":           r["agent_id"],
            "turn_number":        int(r["turn_number"]),
            "is_reflection":      r["is_reflection"].lower() == "true",
            "saved_at":           r["saved_at"],
            "input_tokens":       int(r["input_tokens"]),
            "output_tokens":      int(r["output_tokens"]),
            "cache_read_tokens":  int(r["cache_read_tokens"]),
            "cache_write_tokens": int(r["cache_write_tokens"]),
            "cost_usd":           float(r["cost_usd"]),
            "stop_reason":        r["stop_reason"],
            "tools_called":       [t for t in r["tools_called"].split("|") if t],
            "bash_commands":      [c for c in r.get("bash_commands", "").split("|") if c],
        })
    return rows


# ---------------------------------------------------------------------------
# Table 1 — agent statistics
# ---------------------------------------------------------------------------

def compute_agent_stats(rows):
    agents = collections.OrderedDict()

    for r in rows:
        aid = r["agent_id"]
        if aid not in agents:
            agents[aid] = {
                "agent_id":           aid,
                "calls":              0,
                "reflection_calls":   0,
                "turns":              set(),
                "input_tokens":       0,
                "output_tokens":      0,
                "cache_read_tokens":  0,
                "cache_write_tokens": 0,
                "cost_usd":           0.0,
                "stop_reasons":       collections.Counter(),
                "first_at":           None,
                "last_at":            None,
            }
        a = agents[aid]
        a["calls"] += 1
        if r["is_reflection"]:
            a["reflection_calls"] += 1
        a["turns"].add(r["turn_number"])
        a["input_tokens"]       += r["input_tokens"]
        a["output_tokens"]      += r["output_tokens"]
        a["cache_read_tokens"]  += r["cache_read_tokens"]
        a["cache_write_tokens"] += r["cache_write_tokens"]
        a["cost_usd"]           += r["cost_usd"]
        if r["stop_reason"]:
            a["stop_reasons"][r["stop_reason"]] += 1
        if r["saved_at"]:
            ts = r["saved_at"]
            if a["first_at"] is None or ts < a["first_at"]:
                a["first_at"] = ts
            if a["last_at"] is None or ts > a["last_at"]:
                a["last_at"] = ts

    # Convert turns set to count
    for a in agents.values():
        a["turns"] = len(a["turns"])

    return list(agents.values())


def agent_stats_total(stats):
    total = {
        "agent_id":           "TOTAL",
        "calls":              sum(a["calls"] for a in stats),
        "reflection_calls":   sum(a["reflection_calls"] for a in stats),
        "turns":              sum(a["turns"] for a in stats),
        "input_tokens":       sum(a["input_tokens"] for a in stats),
        "output_tokens":      sum(a["output_tokens"] for a in stats),
        "cache_read_tokens":  sum(a["cache_read_tokens"] for a in stats),
        "cache_write_tokens": sum(a["cache_write_tokens"] for a in stats),
        "cost_usd":           sum(a["cost_usd"] for a in stats),
        "stop_reasons":       collections.Counter(),
        "first_at":           None,
        "last_at":            None,
    }
    for a in stats:
        total["stop_reasons"].update(a["stop_reasons"])
        if a["first_at"]:
            if total["first_at"] is None or a["first_at"] < total["first_at"]:
                total["first_at"] = a["first_at"]
        if a["last_at"]:
            if total["last_at"] is None or a["last_at"] > total["last_at"]:
                total["last_at"] = a["last_at"]
    return total


def cache_hit_rate(a):
    denom = a["input_tokens"] + a["cache_read_tokens"]
    return a["cache_read_tokens"] / denom if denom > 0 else 0.0


# ---------------------------------------------------------------------------
# Table 2 — per-tool context impact
# ---------------------------------------------------------------------------

def ctx_size(r):
    return r["input_tokens"] + r["cache_read_tokens"]


def split_monotone_segments(group_rows):
    """
    Split a sorted list of LLM call rows into monotone context segments so
    that Research sub-loop calls (isolated small context) are never paired
    with parent-loop calls (large context) when computing deltas.

    Two split conditions — both cut a new segment:
      DROP:     ctx[i+1] < ctx[i] * 0.8   — entering a sub-loop
      RECOVERY: ctx[i+1] > peak * 0.8 AND ctx[i] < peak * 0.5
                                            — exiting a sub-loop back to main

    `peak` tracks the highest context seen across all previous segments so
    we can recognise when a call "returns" to the main-loop scale.
    """
    if not group_rows:
        return []
    segments = []
    current = [group_rows[0]]
    peak = ctx_size(group_rows[0])

    for r in group_rows[1:]:
        prev_ctx = ctx_size(current[-1])
        next_ctx = ctx_size(r)

        entering_sublevel = prev_ctx > 0 and next_ctx < prev_ctx * 0.8
        recovering_to_main = next_ctx > peak * 0.8 and prev_ctx < peak * 0.5

        if entering_sublevel or recovering_to_main:
            segments.append(current)
            current = [r]
        else:
            current.append(r)

        peak = max(peak, next_ctx)

    segments.append(current)
    return segments


def compute_tool_stats(rows, total_input_tokens, total_cost_usd):
    # Group rows by (agent_id, turn_number), sort each group by saved_at
    groups = collections.defaultdict(list)
    for r in rows:
        groups[(r["agent_id"], r["turn_number"])].append(r)
    for key in groups:
        groups[key].sort(key=lambda r: r["saved_at"])

    total_calls = len(rows)

    # avg cost per total context token across the mission
    avg_input_cost_per_tok = (
        total_cost_usd / total_input_tokens if total_input_tokens > 0 else 0.0
    )

    tool_data = collections.defaultdict(lambda: {
        "calls": 0,
        "delta_sum": 0,
        "output_tok_sum": 0,
    })

    for group_rows in groups.values():
        for segment in split_monotone_segments(group_rows):
            for i, r in enumerate(segment):
                tools = r["tools_called"]
                if not tools:
                    continue
                # Context delta: growth in total context (input + cache_read) from
                # this call to the next within the same monotone segment.
                # Reflections run in a separate smaller context — skip those pairs.
                if (
                    i + 1 < len(segment)
                    and not r["is_reflection"]
                    and not segment[i + 1]["is_reflection"]
                ):
                    delta = max(0, ctx_size(segment[i + 1]) - ctx_size(r))
                    delta_per_tool = delta / len(tools)
                else:
                    delta_per_tool = 0

                for t in tools:
                    tool_data[t]["calls"] += 1
                    tool_data[t]["delta_sum"] += delta_per_tool
                    tool_data[t]["output_tok_sum"] += r["output_tokens"]

    # Also count calls where no tools were invoked (stop reason = end_turn, no tools)
    # These are not attributed to any tool — skip them in Table 2.

    result = []
    for tool_name, td in tool_data.items():
        calls = td["calls"]
        avg_delta = td["delta_sum"] / calls if calls > 0 else 0.0
        avg_output = td["output_tok_sum"] / calls if calls > 0 else 0.0
        est_ctx_cost = calls * avg_delta * avg_input_cost_per_tok
        result.append({
            "tool": tool_name,
            "calls": calls,
            "calls_pct": 100.0 * calls / total_calls if total_calls > 0 else 0.0,
            "avg_ctx_delta": avg_delta,
            "avg_output_tok": avg_output,
            "est_ctx_cost": est_ctx_cost,
        })

    result.sort(key=lambda x: x["avg_ctx_delta"], reverse=True)
    return result


# ---------------------------------------------------------------------------
# Formatters
# ---------------------------------------------------------------------------

def fmt_m(tokens):
    """Format token count in millions."""
    return f"{tokens / 1_000_000:.1f}"


def fmt_k(tokens):
    """Format token count in thousands with one decimal."""
    return f"{tokens / 1_000:.1f}k"


def fmt_pct(rate):
    return f"{rate * 100:.1f}%"


def fmt_cost(usd):
    if usd >= 10:
        return f"${usd:.2f}"
    return f"${usd:.4f}"


def rule(widths, char="─", sep="┼"):
    return sep.join(char * w for w in widths)


def row_str(cells, widths):
    return "│".join(
        cell.ljust(widths[i]) if i == 0 else cell.rjust(widths[i])
        for i, cell in enumerate(cells)
    )


# ---------------------------------------------------------------------------
# Output: Table 1
# ---------------------------------------------------------------------------

def print_table1(stats, total, csv_mode=False):
    headers = ["Agent", "Calls", "Refl%", "Turns", "Input(M)", "Output(M)", "CacheR(M)", "CacheHit%", "Cost"]
    all_rows = stats + [total]

    if csv_mode:
        w = csv.writer(sys.stdout)
        print("# AGENT_STATS")
        w.writerow(headers)
        for a in all_rows:
            w.writerow([
                a["agent_id"],
                a["calls"],
                f"{100.0 * a['reflection_calls'] / a['calls']:.1f}" if a["calls"] > 0 else "0.0",
                a["turns"],
                fmt_m(a["input_tokens"]),
                fmt_m(a["output_tokens"]),
                fmt_m(a["cache_read_tokens"]),
                fmt_pct(cache_hit_rate(a)),
                f"{a['cost_usd']:.4f}",
            ])
        return

    def make_row(a, is_total=False):
        refl_pct = f"{100.0 * a['reflection_calls'] / a['calls']:.1f}%" if a["calls"] > 0 else "0.0%"
        return [
            a["agent_id"],
            str(a["calls"]),
            refl_pct,
            str(a["turns"]),
            fmt_m(a["input_tokens"]),
            fmt_m(a["output_tokens"]),
            fmt_m(a["cache_read_tokens"]),
            fmt_pct(cache_hit_rate(a)),
            fmt_cost(a["cost_usd"]),
        ]

    data_rows = [make_row(a) for a in stats]
    total_row = make_row(total, is_total=True)

    # Column widths: max of header and all data
    widths = [len(h) for h in headers]
    for r in data_rows + [total_row]:
        for i, cell in enumerate(r):
            widths[i] = max(widths[i], len(cell))
    # Add padding
    widths = [w + 2 for w in widths]

    sep = rule(widths)
    print()
    print("  Agent Token Statistics")
    print()
    print(row_str(headers, widths))
    print(sep)
    for r in data_rows:
        print(row_str(r, widths))
    print(sep)
    print(row_str(total_row, widths))
    print()

    # Mission date range + stop reasons
    if total["first_at"] and total["last_at"]:
        print(f"  Date range: {total['first_at'][:10]} → {total['last_at'][:10]}")
    if total["stop_reasons"]:
        reasons = ", ".join(f"{k}: {v}" for k, v in total["stop_reasons"].most_common())
        print(f"  Stop reasons: {reasons}")
    print()


# ---------------------------------------------------------------------------
# Output: Table 2
# ---------------------------------------------------------------------------

def print_table2(tool_stats, csv_mode=False):
    headers = ["Tool", "Calls", "Calls%", "AvgCtxDelta", "AvgOutputTok", "EstCtxCost"]

    if csv_mode:
        w = csv.writer(sys.stdout)
        print("# TOOL_STATS")
        w.writerow(headers)
        for t in tool_stats:
            w.writerow([
                t["tool"],
                t["calls"],
                f"{t['calls_pct']:.1f}",
                f"{t['avg_ctx_delta']:.0f}",
                f"{t['avg_output_tok']:.0f}",
                f"{t['est_ctx_cost']:.4f}",
            ])
        return

    def make_row(t):
        return [
            t["tool"],
            str(t["calls"]),
            f"{t['calls_pct']:.1f}%",
            fmt_k(t["avg_ctx_delta"]) if t["avg_ctx_delta"] >= 100 else f"{t['avg_ctx_delta']:.0f}",
            f"{t['avg_output_tok']:,.0f}",
            f"~{fmt_cost(t['est_ctx_cost'])}",
        ]

    data_rows = [make_row(t) for t in tool_stats]
    widths = [len(h) for h in headers]
    for r in data_rows:
        for i, cell in enumerate(r):
            widths[i] = max(widths[i], len(cell))
    widths = [w + 2 for w in widths]

    sep = rule(widths)
    print()
    print("  Per-Tool Context Impact  (sorted by avg context delta, highest first)")
    print()
    print(row_str(headers, widths))
    print(sep)
    for r in data_rows:
        print(row_str(r, widths))
    print()

    # Warnings for high-impact tools
    for t in tool_stats:
        if t["avg_ctx_delta"] > 3_000:
            print(f"  ⚠  {t['tool']} adds {fmt_k(t['avg_ctx_delta'])} tokens to context per call on average")
    print()


# ---------------------------------------------------------------------------
# Table 3 — Bash command breakdown
# ---------------------------------------------------------------------------

def compute_bash_stats(rows):
    """Count verb occurrences. Verbs are pre-extracted by cli-analyze-dump.ts."""
    verbs = collections.Counter()
    for r in rows:
        for verb in r["bash_commands"]:
            if verb:
                verbs[verb] += 1
    return verbs


def print_table3(bash_stats, total_bash_calls, csv_mode=False):
    if not bash_stats:
        return

    headers = ["Command", "Calls", "Calls%"]
    top = bash_stats.most_common(20)

    if csv_mode:
        w = csv.writer(sys.stdout)
        print("# BASH_COMMANDS")
        w.writerow(headers)
        for verb, count in top:
            w.writerow([verb, count, f"{100.0 * count / total_bash_calls:.1f}"])
        return

    data_rows = [
        [verb, str(count), f"{100.0 * count / total_bash_calls:.1f}%"]
        for verb, count in top
    ]
    widths = [len(h) for h in headers]
    for r in data_rows:
        for i, cell in enumerate(r):
            widths[i] = max(widths[i], len(cell))
    widths = [w + 2 for w in widths]

    sep = rule(widths)
    print()
    print("  Bash Command Verbs  (top 20 by frequency)")
    print()
    print(row_str(headers, widths))
    print(sep)
    for r in data_rows:
        print(row_str(r, widths))
    print()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    csv_mode = "--csv" in sys.argv

    rows = load_rows(sys.stdin)
    if not rows:
        sys.stderr.write("No data on stdin — is the dump empty?\n")
        sys.exit(1)

    agent_stats = compute_agent_stats(rows)
    total = agent_stats_total(agent_stats)

    total_input = total["input_tokens"] + total["cache_read_tokens"]
    total_cost  = total["cost_usd"]

    tool_stats = compute_tool_stats(rows, total_input, total_cost)
    bash_stats = compute_bash_stats(rows)
    total_bash_calls = sum(bash_stats.values())

    print_table1(agent_stats, total, csv_mode=csv_mode)
    print_table2(tool_stats, csv_mode=csv_mode)
    if total_bash_calls > 0:
        print_table3(bash_stats, total_bash_calls, csv_mode=csv_mode)


if __name__ == "__main__":
    main()
