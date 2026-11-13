#!/usr/bin/env python3
"""List MAGI's entry points from the code: every route, copilot action, tool,
background-job tool and scheduled task an actor can call, with file:line.

This is the bottom-up half of the operations inventory: it says what exists,
not what each entry point does. Use it to reconcile your top-down list — an
entry point no operation explains, or an operation with an entry point you had
not listed — then read the code of each entry point to see what it reaches.

Usage:
  python3 entry-points.py <clone>              # Markdown table, one row per entry point
  python3 entry-points.py <clone> --counts     # counts per kind only

Pattern-based (no TypeScript compiler): it finds the registration shapes the
code uses today. A new shape is missed, so compare the counts with what you
know (the agents' tool catalogue in tool-catalog.ts, the action registry in
copilot-actions.ts) before trusting it as complete.
"""
import os
import re
import sys

CP = "packages/control-plane/src"
WK = "packages/agent-runtime-worker/src"


def ts_files(clone, base):
    root = os.path.join(clone, base)
    for d, dirs, names in os.walk(root):
        dirs[:] = [x for x in dirs if x not in ("node_modules", "dist")]
        for n in names:
            if n.endswith(".ts") and not n.endswith(".d.ts"):
                yield os.path.join(d, n)


def rel(clone, p):
    return os.path.relpath(p, clone)


def actor_of(path):
    if "/mission-copilot" in path or path.endswith("resource-upgrade-tool.ts"):
        return "mission copilot tool"
    if "control-plane/src/copilot" in path:
        return "control copilot tool"
    if path.endswith("data-provider-proxy.ts"):
        return "background-job tool"
    if path.endswith("image-agent-tools.ts"):
        return "sub-agent tool (image agent)"
    return "agent tool"


def entries(clone):
    out = []
    # The path may sit on the line after the call (formatter), so search the whole file.
    route = re.compile(r"\.(get|post|put|patch|delete)\(\s*[\"'](/[^\"']*)[\"']")
    for p in ts_files(clone, CP):
        text = open(p, encoding="utf-8").read()
        for m in route.finditer(text):
            line = text[: m.start()].count("\n") + 1
            out.append(("control-plane route", f"{m.group(1).upper()} {m.group(2)}", rel(clone, p), line))
    mounts = []
    idx = os.path.join(clone, CP, "index.ts")
    if os.path.exists(idx):
        for i, line in enumerate(open(idx, encoding="utf-8"), 1):
            m = re.search(r"app\.use\(\s*[\"'](/[^\"']*)[\"']\s*,\s*([A-Za-z]+)", line)
            if m:
                mounts.append((m.group(1), m.group(2), i))

    for p in ts_files(clone, WK):
        lines = open(p, encoding="utf-8").read().split("\n")
        for i, line in enumerate(lines):
            m = re.search(r"method:\s*[\"'](GET|POST|PUT|PATCH|DELETE)[\"']", line)
            if m:
                window = "\n".join(lines[i : i + 4])
                pm = re.search(r"path:\s*[\"'](/[^\"']*)[\"']", window)
                if pm:
                    out.append(("mission daemon route", f"{m.group(1)} {pm.group(1)}", rel(clone, p), i + 1))

    for base in (CP, WK):
        for p in ts_files(clone, base):
            lines = open(p, encoding="utf-8").read().split("\n")
            for i, line in enumerate(lines):
                m = re.search(r"\bname:\s*[\"']([A-Za-z_][\w-]*)[\"']", line)
                if m and re.search(r"\bexecute\b", "\n".join(lines[i : i + 60])) and not re.search(r"\bname:\s*[\"']", "\n".join(lines[i + 1 : i + 3])):
                    rp = rel(clone, p)
                    out.append((actor_of(rp), m.group(1), rp, i + 1))

    acts = os.path.join(clone, CP, "copilot-actions.ts")
    if os.path.exists(acts):
        text = open(acts, encoding="utf-8").read()
        start = text.find("ACTION_SCHEMAS")
        end = text.find("};", start)
        block = text[start:end]
        base_line = text[:start].count("\n") + 1
        names = set()
        for j, line in enumerate(block.split("\n")):
            m = re.match(r"\t([a-z_]+):\s", line)
            if m and m.group(1) not in names:
                names.add(m.group(1))
                out.append(("control copilot action", m.group(1), rel(clone, acts), base_line + j))
        if "GITHUB_ISSUE_ACTION" in text:
            out.append(("control copilot action", "file_github_issue", rel(clone, acts), text[: text.find("GITHUB_ISSUE_ACTION")].count("\n") + 1))

    api = os.path.join(clone, WK, "tool-api-server.ts")
    if os.path.exists(api):
        seen = set()
        for i, line in enumerate(open(api, encoding="utf-8"), 1):
            for m in re.finditer(r"normalised\s*===\s*[\"']([\w-]+)[\"']", line):
                name = m.group(1)
                if name.replace("-", "") in seen:
                    continue
                seen.add(name.replace("-", ""))
                out.append(("background-job tool", name, rel(clone, api), i))

    for base in (CP, WK):
        for p in ts_files(clone, base):
            for i, line in enumerate(open(p, encoding="utf-8"), 1):
                m = re.search(r"\bschedule\(\s*[\"']([^\"']+)[\"']\s*,\s*([^)]{1,60})", line)
                if m:
                    out.append(("scheduled task", f"cron {m.group(1)}: {m.group(2).strip()}", rel(clone, p), i))
                elif re.search(r"\bsetInterval\(", line) and "keepalive" not in line and "heartbeat" not in line.lower():
                    out.append(("scheduled task", "interval: " + line.strip()[:60], rel(clone, p), i))
    return out, mounts


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    clone = sys.argv[1]
    rows, mounts = entries(clone)
    kinds = sorted({r[0] for r in rows})
    if "--counts" in sys.argv:
        for k in kinds:
            print(f"{k}: {sum(1 for r in rows if r[0] == k)}")
        print("total:", len(rows))
        return
    print(f"# Entry points ({len(rows)})\n")
    print("Control-plane routers are mounted under these prefixes (packages/control-plane/src/index.ts):\n")
    for prefix, factory, line in mounts:
        print(f"- `{prefix}` ← {factory} (index.ts:{line})")
    for k in kinds:
        ks = [r for r in rows if r[0] == k]
        print(f"\n## {k} ({len(ks)})\n\n| Entry point | Where |\n|---|---|")
        for _, ident, path, line in ks:
            print(f"| `{ident}` | {path}:{line} |")


if __name__ == "__main__":
    main()
