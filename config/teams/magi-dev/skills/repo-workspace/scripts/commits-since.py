#!/usr/bin/env python3
"""List the commits after a cursor, with changed files and a first triage.

The triage is a starting point, not a verdict: it marks each changed file
"deep", "skim" or "skip" for a lens, from file patterns and from signals in
the added lines. The reviewer decides how deep to go.

Usage: python3 commits-since.py <clone-dir> <cursor-sha> [--lens security|code|docs] [--max 60]
Output: one block per commit, oldest first, then a summary line.
"""
import argparse
import re
import subprocess
import sys

SECURITY_PATHS = [
    r"ssrf", r"safe-(http|path|git)", r"auth", r"session", r"token", r"proxy",
    r"monitor-", r"tool-api", r"job-(runner|recovery)", r"sudo", r"linux-user",
    r"workspace-manager", r"tool-executor", r"egress", r"copilot-actions",
    r"pending-actions", r"github", r"fly-", r"machine-lifecycle", r"secrets",
    r"Dockerfile", r"\.github/workflows/", r"scripts/(bootstrap|promote|deploy)",
    r"\.dockerignore", r"package(-lock)?\.json$", r"\.nsprc$",
    r"docs/security/", r"team-files", r"loader\.ts$", r"markdown\.ts$",
    r"security-headers",
]
SECURITY_SIGNALS = [
    r"\bspawn\(", r"\bexeca?\(", r"\bexecFile", r"\bsudo\b", r"process\.env",
    r"\bfetch\(", r"http\.request", r"\$where", r"\$regex", r"\bsetfacl\b",
    r"createWriteStream|writeFile|appendFile|readFile|realpath|symlink|O_NOFOLLOW",
    r"router\.(get|post|put|patch|delete)\(|app\.(get|post|put|patch|delete)\(",
    r"innerHTML|dangerouslySetInnerHTML", r"\beval\(|new Function\(",
    r"Authorization|x-monitor-token|cookie", r"chmod|chown|setuid",
]
DOC_PATHS = [r"\.md$", r"docs/", r"env-catalog", r"\.ya?ml$"]
SKIP = [r"(^|/)tests?/", r"\.test\.ts$", r"\.snap$", r"^experimental/"]


def git(clone, *args):
    out = subprocess.run(["git", "-C", clone, *args], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"commits-since: git {' '.join(args)} failed: {out.stderr.strip()}")
    return out.stdout


def classify(path, added, lens):
    if any(re.search(p, path) for p in SKIP):
        return "skip", []
    if lens == "docs":
        return ("deep" if any(re.search(p, path) for p in DOC_PATHS) else "skim"), []
    if lens == "code":
        if path.endswith(".md"):
            return "skip", []
        return ("deep" if re.search(r"\.(ts|tsx|py|sh|mjs)$", path) else "skim"), []
    hits = [p for p in SECURITY_SIGNALS if re.search(p, added)]
    if any(re.search(p, path) for p in SECURITY_PATHS) or hits:
        return "deep", hits
    if path.endswith(".md"):
        return "skip", []
    return "skim", []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clone")
    ap.add_argument("cursor")
    ap.add_argument("--lens", choices=["security", "code", "docs"], default="security")
    ap.add_argument("--max", type=int, default=60)
    a = ap.parse_args()
    if not re.fullmatch(r"[0-9a-f]{7,40}", a.cursor):
        sys.exit("commits-since: cursor must be a commit sha")

    shas = git(a.clone, "rev-list", "--reverse", f"{a.cursor}..HEAD").split()
    total = len(shas)
    shas = shas[: a.max]
    counts = {"deep": 0, "skim": 0, "skip": 0}
    for sha in shas:
        print(git(a.clone, "log", "-1", "--format=== %h %cs %an: %s", sha).rstrip())
        for line in git(a.clone, "show", "--format=", "--numstat", sha).splitlines():
            parts = line.split("\t")
            if len(parts) != 3:
                continue
            plus, minus, path = parts
            added = git(a.clone, "show", "--format=", "--unified=0", sha, "--", path)
            added = "\n".join(l for l in added.splitlines() if l.startswith("+"))
            level, hits = classify(path, added, a.lens)
            counts[level] += 1
            sig = f"  signals: {len(hits)}" if hits else ""
            print(f"  [{level}] {path} (+{plus} -{minus}){sig}")
    more = f"; {total - len(shas)} more after these, run again from the last one" if total > len(shas) else ""
    print(f"-- {len(shas)} of {total} commits after {a.cursor[:7]}; files deep {counts['deep']}, skim {counts['skim']}, skip {counts['skip']}{more}")


if __name__ == "__main__":
    main()
