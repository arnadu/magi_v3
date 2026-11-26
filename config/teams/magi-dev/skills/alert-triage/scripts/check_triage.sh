#!/usr/bin/env bash
# Task checks for alert triage (ADR-0038): run by the platform when a task is completed, as the
# agent completing it, with WORKDIR, SHARED_DIR and AGENT_ID set. Reads only; exit 0 = done.
#
#   check_triage.sh scheduled    the daily job is scheduled for this agent, and a run has finished
#   check_triage.sh first-pass   the newest run deferred nothing, and every finding of every run
#                                is in the findings register (by its item id)
set -euo pipefail
MODE="${1:-}"
python3 -I - "$MODE" "$WORKDIR" "$SHARED_DIR" "${AGENT_ID:-}" <<'EOF'
import json, os, re, sys

mode, workdir, shared, agent = sys.argv[1:5]
runs_dir = os.path.join(workdir, "review", "state", "runs")
runs = sorted(d for d in os.listdir(runs_dir)) if os.path.isdir(runs_dir) else []

def fail(msg):
    print(msg)
    sys.exit(1)

def summary(stamp):
    with open(os.path.join(runs_dir, stamp, "summary.json"), encoding="utf-8") as f:
        return json.load(f)

if mode == "scheduled":
    spec_path = os.path.join(shared, "schedules", "alert-triage.json")
    if not os.path.isfile(spec_path):
        fail(f"no schedule at {spec_path}")
    with open(spec_path, encoding="utf-8") as f:
        spec = json.load(f)
    job = spec.get("jobSpec", {})
    if not str(job.get("scriptPath", "")).endswith("/alert-triage/scripts/run_triage.sh"):
        fail(f"{spec_path} does not run alert-triage/scripts/run_triage.sh")
    if job.get("notifyAgentId") != agent:
        fail(f"{spec_path} does not notify {agent} when a run finishes")
    if not runs:
        fail(f"scheduled ({spec.get('cron')}), but no run has finished yet in {runs_dir}")
    print(f"scheduled: {spec.get('cron')} UTC, notifies {agent}; "
          f"{len(runs)} run(s) finished, newest {runs[-1]}: {json.dumps(summary(runs[-1])['counts'])}")
elif mode == "first-pass":
    if not runs:
        fail(f"no run has finished yet in {runs_dir}")
    newest = summary(runs[-1])
    deferred = newest.get("counts", {}).get("deferred", 0)
    if deferred:
        fail(f"newest run {runs[-1]} deferred {deferred} item(s): the backlog is not through yet")
    register = os.path.join(shared, "reports", "security", "register.md")
    text = open(register, encoding="utf-8").read() if os.path.isfile(register) else ""
    findings = {}
    for stamp in runs:
        path = os.path.join(runs_dir, stamp, "findings.json")
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as f:
                for x in json.load(f):
                    findings.setdefault(x["item_id"], stamp)
    # Whole ids only: cs-4 must not be satisfied by cs-42.
    def recorded(i):
        return re.search(r"(?<![\w.-])" + re.escape(i) + r"(?![\w-])", text) is not None
    missing = [f"{i} (run {s})" for i, s in sorted(findings.items()) if not recorded(i)]
    if missing:
        fail(f"{len(missing)} finding(s) not yet in {register}, as verified or dismissed: "
             + ", ".join(missing[:20]))
    print(f"newest run {runs[-1]} deferred nothing ({json.dumps(newest['counts'])}); "
          f"all {len(findings)} finding(s) from {len(runs)} run(s) are in {register}")
else:
    fail("usage: check_triage.sh scheduled|first-pass")
EOF
