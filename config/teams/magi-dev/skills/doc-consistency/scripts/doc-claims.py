#!/usr/bin/env python3
"""Turn a document into a numbered checklist of its claims, then count the verdicts.

A check of a document against the code is complete only when every claim has
a verdict and evidence. This script does the mechanical part so nothing is
skipped: it lists the claims; you fill in each verdict; it counts them.

Usage:
  python3 doc-claims.py extract <doc.md> [--section "<heading text>"] --out <checklist.md>
  python3 doc-claims.py summary <checklist.md>

extract: one line per claim — every table row, every list item, and every
  sentence that names code (`backticks`), a number, a status (open, fixed,
  ⚠️, ✅, ...) or a behaviour (must, only, never, requires, runs, ...).
  Each line ends with `| ? | ` : replace `?` with confirmed, wrong,
  unverifiable or not-a-claim, and write the evidence after the last `|`
  (file:line, or the command and its output).
summary: counts per verdict and per section; exits 1 while any claim is
  still `?`, or is confirmed or wrong without evidence.
"""
import argparse
import re
import sys

STATUS = re.compile(
    r"`|\d|⚠️|✅|❌|~|\b(open|fixed|accepted|deferred|done|planned|retired|deleted|enforc\w*|"
    r"must|only|never|always|requires?|runs?|writes?|reads?|calls?|checks?|validat\w*|"
    r"default|max\w*|min\w*|every|each|no longer|not)\b",
    re.I,
)
VERDICTS = {"confirmed", "wrong", "unverifiable", "not-a-claim"}


def sentences(text):
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+(?=[A-Z`*(\[])", text) if s.strip()]


def extract(path, section, out):
    lines = open(path, encoding="utf-8").read().split("\n")
    heading, in_section, in_code = "", section is None, False
    claims = []
    para, para_start = [], 0

    def flush():
        nonlocal para
        if para and in_section:
            for s in sentences(" ".join(para)):
                if STATUS.search(s) and len(s) > 15:
                    claims.append((para_start, heading, s))
        para = []

    for n, raw in enumerate(lines, 1):
        line = raw.rstrip()
        if line.startswith("```"):
            flush()
            in_code = not in_code
            if line.strip() == "```mermaid" or line.strip() == "```":
                pass
            continue
        if in_code:
            # Diagram labels and commands still make claims; keep the ones with a marker.
            if in_section and re.search(r"⚠️|✅|no auth|only|never|\bF-\d+|\d+ ?(MB|GB|s|min|h)\b|:\d{2,5}\b", line):
                claims.append((n, heading, line.strip()))
            continue
        m = re.match(r"^(#{1,6})\s+(.*)", line)
        if m:
            flush()
            heading = m.group(2).strip()
            if section is not None:
                level = len(m.group(1))
                if section.lower() in heading.lower():
                    in_section, section_level = True, level
                elif in_section and level <= locals().get("section_level", 0):
                    in_section = False
            continue
        if not in_section:
            continue
        if re.match(r"^\s*\|", line):
            flush()
            if re.match(r"^\s*\|[\s:|-]+\|\s*$", line):
                continue  # separator row
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            # The header row is the one directly above a separator row.
            if n < len(lines) and re.match(r"^\s*\|[\s:|-]+\|\s*$", lines[n] if n < len(lines) else ""):
                continue
            claims.append((n, heading, " | ".join(c for c in cells if c)))
            continue
        if re.match(r"^\s*([-*+]|\d+\.)\s+", line):
            flush()
            claims.append((n, heading, re.sub(r"^\s*([-*+]|\d+\.)\s+", "", line)))
            continue
        if not line.strip():
            flush()
            continue
        if not para:
            para_start = n
        para.append(line.strip())
    flush()

    with open(out, "w", encoding="utf-8") as f:
        f.write(f"# Claims checklist — {path}{f' — section: {section}' if section else ''}\n\n")
        f.write("Verdicts: confirmed · wrong · unverifiable · not-a-claim. Evidence: file:line, or the command and its output.\n\n")
        f.write("| Id | Line | Section | Claim | Verdict | Evidence |\n|---|---|---|---|---|---|\n")
        for i, (n, h, text) in enumerate(claims, 1):
            text = text.replace("|", "\\|")
            if len(text) > 1200:  # long rows keep their end: status markers often sit there
                text = text[:400] + " ... " + text[-795:]
            f.write(f"| C-{i:03d} | {n} | {h[:40]} | {text} | ? | |\n")
    print(f"{len(claims)} claims written to {out}")


def summary(path):
    rows = [l for l in open(path, encoding="utf-8") if re.match(r"^\| C-\d{3} \|", l)]
    counts, by_section, problems = {}, {}, []
    for r in rows:
        cells = [c.strip() for c in re.split(r"(?<!\\)\|", r.strip())[1:-1]]
        if len(cells) < 6:
            problems.append(f"{cells[0] if cells else '?'}: malformed row")
            continue
        cid, _line, sec, _claim, verdict, evidence = cells[:6]
        v = verdict.lower()
        counts[v] = counts.get(v, 0) + 1
        by_section.setdefault(sec, {}).setdefault(v, 0)
        by_section[sec][v] += 1
        if v == "?":
            problems.append(f"{cid}: no verdict")
        elif v not in VERDICTS:
            problems.append(f"{cid}: unknown verdict {verdict!r}")
        elif v in ("confirmed", "wrong") and not evidence:
            problems.append(f"{cid}: {v} without evidence")
    total = len(rows)
    print(f"{total} claims: " + ", ".join(f"{counts.get(v, 0)} {v}" for v in ["confirmed", "wrong", "unverifiable", "not-a-claim", "?"]))
    print("\n| Section | " + " | ".join(["confirmed", "wrong", "unverifiable", "not-a-claim"]) + " |\n|---|---|---|---|---|")
    for sec, c in by_section.items():
        print(f"| {sec} | " + " | ".join(str(c.get(v, 0)) for v in ["confirmed", "wrong", "unverifiable", "not-a-claim"]) + " |")
    if problems:
        print(f"\nINCOMPLETE — {len(problems)} problem(s):")
        for p in problems[:40]:
            print("  " + p)
        sys.exit(1)
    print("\ncomplete: every claim has a verdict, and every confirmed or wrong claim has evidence")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("extract")
    e.add_argument("doc")
    e.add_argument("--section")
    e.add_argument("--out", required=True)
    s = sub.add_parser("summary")
    s.add_argument("checklist")
    a = ap.parse_args()
    if a.cmd == "extract":
        extract(a.doc, a.section, a.out)
    else:
        summary(a.checklist)


if __name__ == "__main__":
    main()
