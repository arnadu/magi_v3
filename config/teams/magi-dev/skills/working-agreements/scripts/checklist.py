#!/usr/bin/env python3
"""Work through a review checklist row by row, then count the verdicts.

A checklist is a Markdown table whose rows start with an id (SC-01, CR-12,
QJ-3, ...) and end with two columns: Verdict and Evidence. Copy it, fill in
every row, and let `summary` say whether it is complete.

Usage:
  python3 checklist.py start <checklist.md> --out <your-report-folder>/checklists/YYYY-MM-DD-<name>.md
  python3 checklist.py summary <filled-checklist.md>

Verdicts:
  pass          the item is in place      (evidence: file:line, command output)
  fail          it exists but is wrong    (evidence required; also a finding)
  missing       it should exist and doesn't (evidence: where you looked; also a finding)
  n/a           it doesn't apply here     (evidence: why)
  unverifiable  you couldn't check it     (evidence: why, and what would settle it)

summary exits 1 while any row is still `?`, or has a verdict without evidence.
"""
import os
import re
import shutil
import sys

ROW = re.compile(r"^\|\s*([A-Z]{1,3}-\d{1,3})\s*\|")
VERDICTS = ["pass", "fail", "missing", "n/a", "unverifiable"]


def cells(line):
    return [c.strip() for c in re.split(r"(?<!\\)\|", line.strip())[1:-1]]


def start(src, out):
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    shutil.copyfile(src, out)
    n = sum(1 for l in open(out, encoding="utf-8") if ROW.match(l))
    print(f"{n} checklist rows copied to {out}: fill in Verdict and Evidence for each")


def summary(path):
    counts = {v: 0 for v in VERDICTS + ["?"]}
    problems, findings = [], []
    for line in open(path, encoding="utf-8"):
        m = ROW.match(line)
        if not m:
            continue
        c = cells(line)
        rid, verdict, evidence = c[0], c[-2].lower(), c[-1]
        if verdict not in counts:
            problems.append(f"{rid}: unknown verdict {c[-2]!r}")
            continue
        counts[verdict] += 1
        if verdict == "?":
            problems.append(f"{rid}: no verdict")
        elif not evidence:
            problems.append(f"{rid}: {verdict} without evidence")
        if verdict in ("fail", "missing"):
            findings.append(f"{rid} {verdict}: {c[1] if len(c) > 3 else ''}")
    total = sum(counts.values())
    print(f"{total} rows: " + ", ".join(f"{counts[v]} {v}" for v in VERDICTS + ["?"]))
    if findings:
        print("\nFindings (fail or missing):")
        for f in findings:
            print("  " + f[:200])
    if problems:
        print(f"\nINCOMPLETE — {len(problems)} problem(s):")
        for p in problems[:50]:
            print("  " + p)
        sys.exit(1)
    print("\ncomplete: every row has a verdict and evidence")


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "summary":
        summary(sys.argv[2])
    elif len(sys.argv) == 5 and sys.argv[1] == "start" and sys.argv[3] == "--out":
        start(sys.argv[2], sys.argv[4])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
