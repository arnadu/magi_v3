#!/usr/bin/env python3
"""CI result for commits on the mission's repository, from GitHub's public API.

No credential: GitHub allows 60 unauthenticated requests per hour per address,
so ask for a few commits at a time (one request per commit).

Usage: python3 ci-status.py <sha> [<sha> ...]
Prints one line per commit: overall verdict, then each failed or pending check.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request


def repo_slug():
    shared = os.environ.get("SHARED_DIR")
    if not shared:
        sys.exit("ci-status: SHARED_DIR is not set")
    with open(os.path.join(shared, "team", "repositories.json")) as f:
        url = json.load(f)["repositories"][0]["url"]
    m = re.fullmatch(r"https://github\.com/([\w.-]+/[\w.-]+)", url)
    if not m:
        sys.exit(f"ci-status: not a GitHub repository URL: {url}")
    return m.group(1)


def check_runs(slug, sha):
    req = urllib.request.Request(
        f"https://api.github.com/repos/{slug}/commits/{sha}/check-runs?per_page=100",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "magi-dev-reviewer"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)["check_runs"]
    except urllib.error.HTTPError as e:
        if e.code == 403:
            sys.exit("ci-status: GitHub rate limit reached (60/hour without a credential); try later")
        sys.exit(f"ci-status: GitHub returned {e.code} for {sha}")


def main():
    shas = sys.argv[1:]
    if not shas or not all(re.fullmatch(r"[0-9a-f]{7,40}", s) for s in shas):
        sys.exit(__doc__)
    slug = repo_slug()
    for sha in shas:
        runs = check_runs(slug, sha)
        if not runs:
            print(f"{sha[:7]} no-ci (no checks ran: CI skipped or path-filtered)")
            continue
        bad = [r for r in runs if r["status"] != "completed" or r["conclusion"] not in ("success", "skipped", "neutral")]
        verdict = "green" if not bad else ("pending" if all(r["status"] != "completed" for r in bad) else "red")
        print(f"{sha[:7]} {verdict} ({len(runs)} checks)")
        for r in bad:
            print(f"    {r['name']}: {r['status']}/{r['conclusion']}")


if __name__ == "__main__":
    main()
