#!/usr/bin/env bash
# run-background/scripts/schedule-job.sh
#
# Register a recurring background job schedule.
# Writes a JSON spec to sharedDir/schedules/<label>.json. The daemon imports
# it within a minute; the control plane keeps the clock and, on each cron
# fire, wakes the mission's machine if needed and hands the daemon one job to
# run — as the user who created the file, with that agent's own workdir and
# sharedDir access. Re-running with the same label updates the schedule; rm
# the file to cancel it (within a minute). A fire the mission slept through
# for more than 6 hours is skipped and reported, not run late.
#
# Usage:
#   bash schedule-job.sh \
#     --label   <label> \
#     --cron    "<cron-expression>" \
#     --script  <abs-path-to-script> \
#     [--agent  <agentId>]               (default: $AGENT_ID — must be yourself)
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
#     --notify-subject "Daily refresh complete"
#
# Environment:
#   SHARED_DIR   (required) — mission shared directory
#   AGENT_ID     (set by the Bash tool) — the agent creating the schedule

set -euo pipefail

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------
# Captured before arg parsing reuses the name: the Bash tool sets AGENT_ID.
AGENT_ID_FROM_ENV="${AGENT_ID:-}"
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

AGENT_ID="${AGENT_ID:-$AGENT_ID_FROM_ENV}"

if [[ -z "${LABEL}" || -z "${CRON_EXPR}" || -z "${SCRIPT_PATH}" ]]; then
    echo "Usage: schedule-job.sh --label <label> --cron '<expr>' --script <path> [--agent <id>] [options]" >&2
    exit 1
fi
if [[ -z "${AGENT_ID}" ]]; then
    echo "Error: AGENT_ID is not set and --agent was not given" >&2
    exit 1
fi
if [[ -n "${AGENT_ID_FROM_ENV}" && "${AGENT_ID}" != "${AGENT_ID_FROM_ENV}" ]]; then
    echo "Error: --agent must be your own id (${AGENT_ID_FROM_ENV}); a scheduled job runs as whoever created the schedule file" >&2
    exit 1
fi
if [[ ! "${LABEL}" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]]; then
    echo "Error: label \"${LABEL}\" must be a lower-case slug (a-z 0-9 . _ -, up to 64 chars)" >&2
    exit 1
fi
if [[ "${SCRIPT_PATH}" != /* ]]; then
    echo "Error: --script must be an absolute path" >&2
    exit 1
fi

if [[ -z "${SHARED_DIR:-}" ]]; then
    echo "Error: SHARED_DIR environment variable is required" >&2
    exit 1
fi

SCHEDULES_DIR="${SHARED_DIR}/schedules"
mkdir -p "${SCHEDULES_DIR}"

# Build args JSON array
read -ra ARGS_ARRAY <<< "${ARGS_STR}"
ARGS_JSON="$(python3 -c "import json,sys; print(json.dumps(sys.argv[1:]))" "${ARGS_ARRAY[@]+"${ARGS_ARRAY[@]}"}")"

# Write schedule spec with jobSpec field
OUTPUT="${SCHEDULES_DIR}/${LABEL}.json"

# The job runs as the file's owner: no linux user in the spec (the daemon
# ignores one if present).
python3 -c "
import json, sys
job_spec = {
    'agentId':    sys.argv[1],
    'scriptPath': sys.argv[2],
    'args':       json.loads(sys.argv[3]),
}
if sys.argv[4]:
    job_spec['notifyAgentId'] = sys.argv[5] if sys.argv[5] else sys.argv[1]
    job_spec['notifySubject'] = sys.argv[4]
spec = {
    'label':   sys.argv[6],
    'cron':    sys.argv[7],
    'jobSpec': job_spec,
}
print(json.dumps(spec, indent=2))
" \
    "${AGENT_ID}" \
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
echo "  Agent  : ${AGENT_ID} (runs as the owner of this file)"
echo ""
echo "The daemon imports this schedule within 1 minute (log: '[daemon:scheduler] Schedule imported: ${LABEL} → next at …')."
echo "Each fire appears as job ${LABEL}-<epoch-ms>; rm the file to cancel the schedule."
