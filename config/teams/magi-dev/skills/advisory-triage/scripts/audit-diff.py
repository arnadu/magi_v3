#!/usr/bin/env python3
"""Run `npm audit` on a clone's lockfile and compare with the last baseline.

Needs no `npm install`: `--package-lock-only` reads package-lock.json.
Baselines are kept in $SHARED_DIR/reports/security/advisories/.

Usage: python3 audit-diff.py <clone-dir> [--save]
  Prints advisories that are new since the last baseline, then those that
  are gone, then a one-line total. --save stores this run as the new baseline.
"""
import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone


RANK = {"critical": 0, "high": 1, "moderate": 2, "low": 3, "info": 4}


def run_audit(clone, prod_only):
    cmd = ["npm", "audit", "--package-lock-only", "--json"]
    if prod_only:
        cmd.append("--omit=dev")
    out = subprocess.run(cmd, cwd=clone, capture_output=True, text=True)
    try:
        report = json.loads(out.stdout)
    except json.JSONDecodeError:
        sys.exit(f"audit-diff: npm audit gave no JSON (exit {out.returncode}): {out.stderr.strip()[:500]}")
    if "error" in report:
        sys.exit(f"audit-diff: npm audit failed: {json.dumps(report['error'])[:500]}")
    found = {}
    for name, v in report.get("vulnerabilities", {}).items():
        for via in v.get("via", []):
            if isinstance(via, dict):
                key = f"{name} {via.get('url', via.get('title', '?'))}"
                found[key] = {
                    "package": name,
                    "severity": via.get("severity", v.get("severity")),
                    "title": via.get("title", ""),
                    "url": via.get("url", ""),
                    "range": via.get("range", v.get("range", "")),
                    "direct": v.get("isDirect", False),
                    "fixAvailable": bool(v.get("fixAvailable")),
                    "production": prod_only,
                }
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clone")
    ap.add_argument("--save", action="store_true")
    a = ap.parse_args()
    shared = os.environ.get("SHARED_DIR")
    if not shared:
        sys.exit("audit-diff: SHARED_DIR is not set")
    base_dir = os.path.join(shared, "reports", "security", "advisories")
    os.makedirs(base_dir, exist_ok=True)

    current = run_audit(a.clone, prod_only=False)
    prod = run_audit(a.clone, prod_only=True)
    for k in current:
        current[k]["production"] = k in prod

    baselines = sorted(f for f in os.listdir(base_dir) if f.startswith("baseline-"))
    previous = {}
    if baselines:
        with open(os.path.join(base_dir, baselines[-1])) as f:
            previous = json.load(f)["advisories"]

    def line(v):
        scope = "production" if v["production"] else "dev only"
        fix = "fix available" if v["fixAvailable"] else "no fix yet"
        return f"  {v['severity']:<8} {v['package']} {v['range']} ({scope}, {'direct' if v['direct'] else 'transitive'}, {fix}) {v['title']} {v['url']}"

    new = [current[k] for k in current if k not in previous]
    gone = [previous[k] for k in previous if k not in current]
    print(f"== new since {baselines[-1] if baselines else 'no baseline'}:")
    for v in sorted(new, key=lambda v: RANK.get(v["severity"], 9)):
        print(line(v))
    print("== no longer reported:")
    for v in gone:
        print(line(v))
    by = {}
    for v in current.values():
        by[v["severity"]] = by.get(v["severity"], 0) + 1
    print(f"-- total now {len(current)} {by}; production {sum(v['production'] for v in current.values())}")

    if a.save:
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M")
        head = subprocess.run(["git", "-C", a.clone, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        with open(os.path.join(base_dir, f"baseline-{stamp}.json"), "w") as f:
            json.dump({"commit": head, "advisories": current}, f, indent=1)
        print(f"saved baseline-{stamp}.json at {head[:7]}")


if __name__ == "__main__":
    main()
