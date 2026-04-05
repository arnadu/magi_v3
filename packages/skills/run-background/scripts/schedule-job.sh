#!/usr/bin/env bash
# run-background/scripts/schedule-job.sh
#
# Register a recurring background job schedule.
# Writes a JSON spec to sharedDir/schedules/<label>.json.
# The daemon fires the job on the cron schedule and re-arms it automatically.
# Re-running with the same label updates the schedule (idempotent).
#
# Usage:
#   bash schedule-job.sh \
#     --label   <label> \
#     --cron    "<cron-expression>" \
#     --script  <abs-path-to-script> \
#     --agent   <agentId> \
#     [--args   "<space-separated-args>"] \
#     [--notify-subject "<text>"] \
#     [--notify-agent   <agentId>]
#
# Example — daily 05:30 data refresh:
#   bash schedule-job.sh \
#     --label "daily-refresh" \
#     --cron "30 5 * * *" \
#     --script "$WORKDIR/scripts/refresh.py" \
#     --args "$SHARED_DIR" \
#     --agent "data-scientist" \
#     --notify-subject "Daily refresh complete"
#
# Environment:
#   SHARED_DIR   (required) — mission shared directory
#   LINUX_USER   (optional) — override the linux user to run as

set -euo pipefail

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------
LABEL=""
CRON_EXPR=""
SCRIPT_PATH=""
AGENT_ID=""
ARGS_STR=""
NOTIFY_SUBJECT=""
NOTIFY_AGENT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --label)          LABEL="$2"; shift 2 ;;
        --cron)           CRON_EXPR="$2"; shift 2 ;;
        --script)         SCRIPT_PATH="$2"; shift 2 ;;
        --agent)          AGENT_ID="$2"; shift 2 ;;
        --args)           ARGS_STR="$2"; shift 2 ;;
        --notify-subject) NOTIFY_SUBJECT="$2"; shift 2 ;;
        --notify-agent)   NOTIFY_AGENT="$2"; shift 2 ;;
        *) echo "Unknown flag: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "${LABEL}" || -z "${CRON_EXPR}" || -z "${SCRIPT_PATH}" || -z "${AGENT_ID}" ]]; then
    echo "Usage: schedule-job.sh --label <label> --cron '<expr>' --script <path> --agent <id> [options]" >&2
    exit 1
fi

if [[ -z "${SHARED_DIR:-}" ]]; then
    echo "Error: SHARED_DIR environment variable is required" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Derive sharedDir from script location if SHARED_DIR not set.
# This script lives at: sharedDir/skills/_platform/run-background/scripts/schedule-job.sh
# ---------------------------------------------------------------------------
SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
SHARED_DIR="${SHARED_DIR:-$(dirname "$(dirname "$(dirname "$(dirname "$SCRIPTS_DIR")")")")}"

SCHEDULES_DIR="${SHARED_DIR}/schedules"
mkdir -p "${SCHEDULES_DIR}"

LINUX_USER="${LINUX_USER:-$(whoami)}"

# Build args JSON array
read -ra ARGS_ARRAY <<< "${ARGS_STR}"
ARGS_JSON="$(python3 -c "import json,sys; print(json.dumps(sys.argv[1:]))" "${ARGS_ARRAY[@]+"${ARGS_ARRAY[@]}"}")"

# Write schedule spec with jobSpec field
OUTPUT="${SCHEDULES_DIR}/${LABEL}.json"

python3 -c "
import json, sys
job_spec = {
    'agentId':    sys.argv[1],
    'linuxUser':  sys.argv[2],
    'scriptPath': sys.argv[3],
    'args':       json.loads(sys.argv[4]),
}
if sys.argv[5]:
    job_spec['notifyAgentId'] = sys.argv[6] if sys.argv[6] else sys.argv[1]
    job_spec['notifySubject'] = sys.argv[5]
spec = {
    'label':   sys.argv[7],
    'cron':    sys.argv[8],
    'jobSpec': job_spec,
}
print(json.dumps(spec, indent=2))
" \
    "${AGENT_ID}" \
    "${LINUX_USER}" \
    "${SCRIPT_PATH}" \
    "${ARGS_JSON}" \
    "${NOTIFY_SUBJECT}" \
    "${NOTIFY_AGENT:-${AGENT_ID}}" \
    "${LABEL}" \
    "${CRON_EXPR}" > "${OUTPUT}"

echo "Job schedule registered: ${OUTPUT}"
echo "  Label  : ${LABEL}"
echo "  Cron   : ${CRON_EXPR}"
echo "  Script : ${SCRIPT_PATH}"
echo "  Agent  : ${AGENT_ID} (linux user: ${LINUX_USER})"
echo ""
echo "The daemon will import this schedule on its next heartbeat (within 1 minute)."
