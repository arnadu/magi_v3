#!/usr/bin/env python3
"""Hotspots: source files that change often AND are complex.

Defects concentrate where churn meets complexity (Tornhill, "Your Code as a
Crime Scene"). Complexity here is indentation-based (total logical
indentation of non-blank lines), a language-neutral proxy that tracks
cyclomatic complexity well and needs no installed tools.

Usage: python3 hotspots.py <clone-dir> [--days 90] [--top 20] [--json out.json]
"""
import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter

SOURCE = re.compile(r"\.(ts|tsx|mjs|js|py|sh)$")
EXCLUDE = re.compile(r"(^|/)(tests?|dist|node_modules|experimental)/|\.test\.ts$|\.d\.ts$|\.generated\.")


def git(clone, *args):
    out = subprocess.run(["git", "-C", clone, *args], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"hotspots: git {' '.join(args)} failed: {out.stderr.strip()}")
    return out.stdout


def complexity(path):
    total, lines = 0, 0
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                if not line.strip():
                    continue
                lines += 1
                indent = len(line) - len(line.lstrip(" \t"))
                tabs = line[:indent].count("\t")
                total += tabs + (indent - tabs) // 2
    except FileNotFoundError:
        return 0, 0
    return total, lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clone")
    ap.add_argument("--days", type=int, default=90)
    ap.add_argument("--top", type=int, default=20)
    ap.add_argument("--json")
    a = ap.parse_args()

    log = git(a.clone, "log", f"--since={a.days} days ago", "--format=format:@@", "--name-only", "--no-renames")
    revisions = Counter()
    for chunk in log.split("@@"):
        for path in set(p for p in chunk.split("\n") if p.strip()):
            if SOURCE.search(path) and not EXCLUDE.search(path):
                revisions[path] += 1

    rows = []
    for path, revs in revisions.items():
        cx, loc = complexity(os.path.join(a.clone, path))
        if loc == 0:
            continue
        rows.append({"path": path, "revisions": revs, "complexity": cx, "lines": loc, "score": revs * cx})
    rows.sort(key=lambda r: r["score"], reverse=True)
    top = rows[: a.top]

    print(f"{'score':>8} {'revs':>5} {'cmplx':>6} {'lines':>6}  path   (last {a.days} days)")
    for r in top:
        print(f"{r['score']:>8} {r['revisions']:>5} {r['complexity']:>6} {r['lines']:>6}  {r['path']}")
    head = git(a.clone, "rev-parse", "--short", "HEAD").strip()
    print(f"-- {len(rows)} source files changed in {a.days} days; HEAD {head}")
    if a.json:
        with open(a.json, "w") as f:
            json.dump({"head": head, "days": a.days, "hotspots": top}, f, indent=1)


if __name__ == "__main__":
    main()
