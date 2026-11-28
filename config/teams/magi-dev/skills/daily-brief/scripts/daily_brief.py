#!/usr/bin/env python3
"""daily_brief.py — MAGI DEV's daily brief to the user, built from the mission's records.

    daily_brief.py <shared-dir> <workdir> [--tz America/New_York] [--at 18:00] [--to user]
                   [--reference-status <status.json>] [--force] [--dry-run]

Sends once per local day, on the first run at or after --at in --tz; any other run is silent.
Scheduled in UTC at the two hours that can be 18:00 in New York (`0 22,23 * * *`), it arrives at
18:00 New York time in summer and in winter.

Every line comes from a record, by code; no model writes any of it:
- major issues: new entries of the security register (`reports/security/register.md`), and the
  blocking code-review findings and wrong documentation statements in each new report's
  `**Findings:**` line;
- resolved: register entries that reached `fixed, verified` since the last brief;
- backlog: open register entries by severity with the oldest's age; the pipeline's leads waiting
  for appsec's verification and the alerts not yet triaged, by band, with the oldest's age
  (`status/alert-triage.json`); each reviewer's cursor against the reference copy; the citation
  gate's verdict on each new report (`reports/gate/state.json`).

"Since the last brief" is a comparison with what the last brief saw (`$WORKDIR/daily-brief/
state.json`), not a date filter. The first brief, with no state, takes the last 24 hours.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
from zoneinfo import ZoneInfo

AREAS = ("security", "code-review", "docs")
SEVERITIES = ("CRITICAL", "HIGH", "MEDIUM", "LOW")
BANDS = ("critical", "high", "medium", "low")
MAJOR_TAGS = {"blocking", "wrong"}
STALE_HOURS = 3
REFERENCE_STATUS = "/var/lib/magi/reference/magi-v3/status.json"

HEADING = re.compile(r"^###\s+(MD-\d{3})\s*·\s*([A-Za-z]+)\s*·\s*(.+?)\s+—\s+(.+?)\s*$")
DATE = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")
FINDINGS_LINE = re.compile(r"^\*\*Findings:\*\*\s*(.*)$", re.IGNORECASE | re.MULTILINE)
FINDING = re.compile(r"^([A-Z]{2,4}-\d{2,4})\s*\(([^)]*)\)\s*(.*)$")


# ── reading the records ────────────────────────────────────────────────────


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def read_text(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def is_resolved(status):
    return re.match(r"fixed,?\s*verified", status, re.IGNORECASE) is not None


def is_closed_otherwise(status):
    s = status.lower()
    return s.startswith(("accepted risk", "false positive", "duplicate"))


def parse_register(text):
    """One entry per `### MD-NNN · SEVERITY · status — title` section; `found` is the first
    date of its Found line, else of its History line."""
    entries, current = [], None
    for line in text.splitlines():
        m = HEADING.match(line)
        if m:
            current = {"id": m[1], "severity": m[2].upper(), "status": m[3].strip(),
                       "title": m[4], "found": None, "_history": None}
            entries.append(current)
        elif current and line.startswith("- **Found:**"):
            d = DATE.search(line)
            current["found"] = current["found"] or (d[1] if d else None)
        elif current and line.startswith("- **History:**"):
            d = DATE.search(line)
            current["_history"] = d[1] if d else None
    for e in entries:
        e["found"] = e["found"] or e.pop("_history")
        e.pop("_history", None)
    return entries


def parse_findings(text):
    """The report's `**Findings:**` line: `none`, or `ID (label[, blocking]) title; ...`.
    None when the report has no such line."""
    m = FINDINGS_LINE.search(text)
    if not m:
        return None
    body = m[1].strip()
    if body.lower().rstrip(".") in ("", "none"):
        return []
    out = []
    for part in (p.strip() for p in body.split(";")):
        if not part:
            continue
        f = FINDING.match(part)
        if f:
            tags = {t.strip().lower() for t in f[2].split(",") if t.strip()}
            out.append({"id": f[1], "tags": tags, "title": f[3].strip()})
        else:
            out.append({"id": None, "tags": set(), "title": part})
    return out


def list_reports(shared):
    out = []
    for area in AREAS:
        folder = os.path.join(shared, "reports", area)
        names = sorted(os.listdir(folder)) if os.path.isdir(folder) else []
        for name in names:
            path = os.path.join(folder, name)
            if not name.endswith(".md") or name == "register.md" or not os.path.isfile(path):
                continue
            text = read_text(path)
            title = next((ln[2:].strip() for ln in text.splitlines() if ln.startswith("# ")), name)
            out.append({"rel": f"{area}/{name}", "area": area, "title": title,
                        "mtime": os.path.getmtime(path), "findings": parse_findings(text)})
    return out


# ── what changed since the last brief ──────────────────────────────────────


def changes(register, reports, prev, now_utc):
    """New and resolved register entries and new reports, against the last brief's state;
    without one, the last 24 hours."""
    since = now_utc - dt.timedelta(days=1)
    if prev:
        seen = prev.get("register", {})
        new = [e for e in register if e["id"] not in seen]
        resolved = [e for e in register if is_resolved(e["status"])
                    and e["id"] in seen and not is_resolved(seen[e["id"]])]
        closed = [e for e in register if is_closed_otherwise(e["status"]) and e["id"] in seen
                  and not is_closed_otherwise(seen[e["id"]]) and not is_resolved(seen[e["id"]])]
        known = set(prev.get("reports", []))
        fresh = [r for r in reports if r["rel"] not in known]
    else:
        new = [e for e in register if e["found"] and e["found"] >= since.date().isoformat()]
        resolved, closed = [], []
        fresh = [r for r in reports if r["mtime"] >= since.timestamp()]
    return new, resolved, closed, fresh


def next_state(register, reports, local_date, now_utc):
    return {"lastSentDate": local_date, "lastSentAt": iso(now_utc),
            "register": {e["id"]: e["status"] for e in register},
            "reports": sorted(r["rel"] for r in reports)}


# ── rendering ──────────────────────────────────────────────────────────────


def iso(t):
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def age(since, now_utc):
    """`5 h`, `36 h`, `4 days`; since is an ISO time or a YYYY-MM-DD date."""
    t = parse_iso(since) if since and "T" in since else (
        dt.datetime.fromisoformat(f"{since}T00:00:00+00:00") if since else None)
    if t is None:
        return "age unknown"
    hours = max(0.0, (now_utc - t).total_seconds() / 3600)
    return f"{hours:.0f} h" if hours < 48 else f"{hours / 24:.0f} days"


def ordered(keys, order):
    return sorted(keys, key=lambda k: (order.index(k) if k in order else len(order), k))


def major_section(new, fresh, gate):
    lines, minor = [], {}
    rank = {s: i for i, s in enumerate(SEVERITIES)}
    for e in sorted(new, key=lambda e: rank.get(e["severity"], len(rank))):
        lines.append(f"- **Security** {e['id']} · {e['severity']} · {e['status']} — {e['title']}"
                     " (`reports/security/register.md`)")
    for r in fresh:
        if r["area"] == "security":
            continue
        status = gate.get(r["rel"], {}).get("status")
        note = " — *report rejected by the citation gate*" if status == "rejected" else ""
        for f in r["findings"] or []:
            if f["tags"] & MAJOR_TAGS:
                label = ", ".join(sorted(f["tags"]))
                lines.append(f"- **{'Code review' if r['area'] == 'code-review' else 'Docs'}** "
                             f"{f['id'] or ''} ({label}) {f['title']} (`reports/{r['rel']}`){note}")
            else:
                key = r["area"]
                minor[key] = minor.get(key, 0) + 1
    if not lines:
        lines.append("- None.")
    if minor:
        lines.append("- Other new findings: " + ", ".join(
            f"{n} in {area} reports" for area, n in sorted(minor.items())) + " (not blocking).")
    return lines


def resolved_section(resolved, closed, first):
    if first:
        return ["- First brief: resolutions are counted from tomorrow, against today's register."]
    lines = [f"- {e['id']} · {e['severity']} — {e['title']} ({e['status']})" for e in resolved]
    if not lines:
        lines.append("- None.")
    if closed:
        lines.append("- Also closed: " + ", ".join(f"{e['id']} ({e['status']})" for e in closed))
    return lines


def open_findings_line(register, now_utc):
    open_ = [e for e in register if not is_resolved(e["status"]) and not is_closed_otherwise(e["status"])]
    if not open_:
        return "**Open security findings** (register): none."
    parts = []
    for sev in ordered({e["severity"] for e in open_}, SEVERITIES):
        group = [e for e in open_ if e["severity"] == sev]
        oldest = min((e["found"] for e in group if e["found"]), default=None)
        parts.append(f"{sev} {len(group)} (oldest {age(oldest, now_utc)})")
    return f"**Open security findings** (register, {len(open_)}): " + ", ".join(parts) + "."


def band_parts(by_band, oldest_of, now_utc):
    return ", ".join(
        f"{b} {n}" + (f" (oldest {age(oldest_of(b), now_utc)})" if oldest_of(b) else "")
        for b, n in ((b, by_band[b]) for b in ordered(by_band, BANDS)))


def triage_lines(status, now_utc):
    if not status:
        return ["**Alert triage:** no status published yet (it appears after the next triage run)."]
    lines = []
    waiting = status.get("awaitingVerification", {})
    wb = {b: v["count"] for b, v in waiting.get("byBand", {}).items()}
    lines.append("**Leads awaiting appsec's verification:** " + (
        f"{waiting.get('count', 0)}: " + band_parts(
            wb, lambda b: waiting["byBand"][b].get("oldestSince"), now_utc) + "."
        if waiting.get("count") else "none."))
    b = status.get("backlog", {})
    oldest = b.get("oldestByBand", {})
    left = b.get("left", 0)
    text = f"**Alerts and guards not yet triaged:** {left}"
    if left:
        text += ": " + band_parts(b.get("byBand", {}), lambda band: oldest.get(band), now_utc)
        if not oldest and b.get("oldestWaitingSince"):
            text += f"; oldest {age(b['oldestWaitingSince'], now_utc)}"
    text += (f". Set aside {b.get('setAside', 0)}, over budget {b.get('overBudget', 0)}."
             f" Triage spend today ${b.get('spentTodayUsd', 0):.2f}"
             + (f" of ${b['dayBudgetUsd']:.2f}" if b.get("dayBudgetUsd") else "") + ".")
    lines.append(text)
    written = parse_iso(status.get("writtenAt"))
    if written is None or (now_utc - written).total_seconds() > STALE_HOURS * 3600:
        lines.append(f"*Triage status last published {status.get('writtenAt') or 'never'}: "
                     f"no triage run has published since.*")
    return lines


def reviewers_line(cursors, reference, now_utc):
    head = (reference or {}).get("commit") or ""
    parts = []
    for agent in sorted(cursors):
        c = cursors[agent] or {}
        commit = (c.get("commit") or "")[:7]
        if commit and head.startswith(commit):
            parts.append(f"{agent} up to date")
        else:
            parts.append(f"{agent} at {commit or '?'}, last moved {age(c.get('at'), now_utc)} ago")
    if not parts:
        return "**Reviews:** no review cursor recorded."
    return f"**Reviews against main** ({head[:7] or 'reference copy unknown'}): " + "; ".join(parts) + "."


def reports_lines(fresh, gate):
    if not fresh:
        return ["**New reports:** none."]
    verdict = {"accepted": 0, "rejected": 0, "not yet checked": 0}
    rows = []
    for r in sorted(fresh, key=lambda r: r["rel"]):
        g = gate.get(r["rel"], {})
        status = g.get("status") or "not yet checked"
        verdict[status] = verdict.get(status, 0) + 1
        extra = f", {g.get('not_found')} references not found" if status == "rejected" else ""
        count = ("findings in the register" if r["area"] == "security"
                 else "no Findings line" if r["findings"] is None
                 else f"{len(r['findings'])} finding(s)")
        rows.append(f"  - `{r['rel']}` — {r['title']} ({status}{extra}; {count})")
    head = (f"**New reports:** {len(fresh)}; citation gate: " +
            ", ".join(f"{n} {k}" for k, n in verdict.items() if n) + ".")
    return [head, *rows]


def build(inputs, prev, now_utc, tz):
    register, reports = inputs["register"], inputs["reports"]
    new, resolved, closed, fresh = changes(register, reports, prev, now_utc)
    gate = inputs["gate"]
    major = major_section(new, fresh, gate)
    local = now_utc.astimezone(tz)
    since = parse_iso((prev or {}).get("lastSentAt"))
    since_text = (f"since the last brief ({since.astimezone(tz):%a %d %b %H:%M})" if since
                  else "the last 24 hours (first brief)")
    n_major = sum(1 for ln in major if ln.startswith("- **"))
    body = [f"**MAGI DEV — {local:%A %d %B %Y, %H:%M} {tz.key}** · {since_text}", "",
            "## Major issues discovered", *major, "",
            "## Verified resolved", *resolved_section(resolved, closed, prev is None), "",
            "## Backlog", open_findings_line(register, now_utc), "",
            *[x for ln in triage_lines(inputs["triage"], now_utc) for x in (ln, "")],
            reviewers_line(inputs["cursors"], inputs["reference"], now_utc), "",
            *reports_lines(fresh, gate), "",
            "*Built by code from the register, the reports, the triage status, the review cursors "
            "and the citation gate (skill daily-brief); no model wrote it.*"]
    subject = (f"MAGI DEV daily brief, {local:%d %b}: {n_major} major issue(s), "
               f"{len(resolved)} verified resolved")
    return subject, "\n".join(body), next_state(register, reports, local.date().isoformat(), now_utc)


def gather(shared, reference_status):
    return {
        "register": parse_register(read_text(os.path.join(shared, "reports", "security", "register.md"))),
        "reports": list_reports(shared),
        "gate": read_json(os.path.join(shared, "reports", "gate", "state.json"), {}).get("reports", {}),
        "triage": read_json(os.path.join(shared, "status", "alert-triage.json"), None),
        "cursors": read_json(os.path.join(shared, "reports", "review-cursor.json"), {}),
        "reference": read_json(reference_status, None),
    }


# ── running it ─────────────────────────────────────────────────────────────


def due(now_utc, tz, at, prev):
    """(send?, why not)."""
    local = now_utc.astimezone(tz)
    hh, mm = (int(x) for x in at.split(":"))
    if (local.hour, local.minute) < (hh, mm):
        return False, f"before {at} {tz.key} ({local:%H:%M})"
    if (prev or {}).get("lastSentDate") == local.date().isoformat():
        return False, f"already sent on {local.date()}"
    return True, ""


def save_state(path, state):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=1)
        f.write("\n")
    os.replace(tmp, path)


def main(argv, now_utc=None, post=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("shared")
    ap.add_argument("workdir")
    ap.add_argument("--tz", default="America/New_York")
    ap.add_argument("--at", default="18:00")
    ap.add_argument("--to", default="user")
    ap.add_argument("--reference-status", default=REFERENCE_STATUS)
    ap.add_argument("--force", action="store_true", help="send now, whatever the time")
    ap.add_argument("--dry-run", action="store_true", help="print the brief; send and save nothing")
    a = ap.parse_args(argv)
    if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", a.at):
        ap.error("--at must be HH:MM")
    tz = ZoneInfo(a.tz)
    now_utc = now_utc or dt.datetime.now(dt.timezone.utc)
    state_path = os.path.join(a.workdir, "daily-brief", "state.json")
    prev = read_json(state_path, None)
    ok, why = due(now_utc, tz, a.at, prev)
    if not (ok or a.force or a.dry_run):
        print(json.dumps({"sent": False, "why": why}))
        return 0
    subject, body, state = build(gather(a.shared, a.reference_status), prev, now_utc, tz)
    if a.dry_run:
        print(subject, body, sep="\n\n")
        return 0
    if post is None:
        here = os.path.dirname(os.path.abspath(__file__))
        sys.path.insert(0, os.path.join(here, "..", "..", "..", "_platform", "run-background", "scripts"))
        import magi_tool  # noqa: E402 — only when run as a real job

        post = magi_tool.post_message
    post(a.to, subject, body)
    save_state(state_path, state)
    print(json.dumps({"sent": True, "to": a.to, "subject": subject}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
