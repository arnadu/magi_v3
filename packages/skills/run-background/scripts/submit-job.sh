#!/usr/bin/env bash
# run-background/scripts/submit-job.sh
#
# Submit a one-shot background script for execution by the daemon.
# Writes a job spec to sharedDir/jobs/pending/<jobId>.json.
# The daemon picks it up on its next heartbeat (within 1 minute).
#
# The job runs as the user who created the spec file: the daemon attributes
# it to the file's owner, not to the --agent field, so --agent must be your
# own agent id (it defaults to $AGENT_ID) — a spec naming another agent is
# refused. Do NOT include a linuxUser field; it is ignored.
#
# Usage:
#   bash submit-job.sh \
#     --script   <abs-path-to-script> \
#     [--agent   <agentId>]            (default: $AGENT_ID — must be yourself)
#     [--args    "<space-separated-args>"] \
#     [--notify-subject "<text>"] \
#     [--notify-agent   <agentId>]
#
# Environment:
#   SHARED_DIR   (required) — mission shared directory
#   AGENT_ID     (set by the Bash tool) — the submitting agent

set -euo pipefail

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------
# Captured before arg parsing reuses the name: the Bash tool sets AGENT_ID.
AGENT_ID_FROM_ENV="${AGENT_ID:-}"
SCRIPT_PATH=""
AGENT_ID=""
ARGS_STR=""
NOTIFY_SUBJECT=""
NOTIFY_AGENT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --script)         SCRIPT_PATH="$2"; shift 2 ;;
        --agent)          AGENT_ID="$2"; shift 2 ;;
        --args)           ARGS_STR="$2"; shift 2 ;;
        --notify-subject) NOTIFY_SUBJECT="$2"; shift 2 ;;
        --notify-agent)   NOTIFY_AGENT="$2"; shift 2 ;;
        *) echo "Unknown flag: $1" >&2; exit 1 ;;
    esac
done

AGENT_ID="${AGENT_ID:-$AGENT_ID_FROM_ENV}"
if [[ -z "${SCRIPT_PATH}" ]]; then
    echo "Usage: submit-job.sh --script <path> [--agent <agentId>] [--args '...'] [--notify-subject '...']" >&2
    exit 1
fi
if [[ -z "${AGENT_ID}" ]]; then
    echo "Error: --agent not given and AGENT_ID is not set in the environment" >&2
    exit 1
fi

if [[ -z "${SHARED_DIR:-}" ]]; then
    echo "Error: SHARED_DIR environment variable is required" >&2
    exit 1
fi

PENDING_DIR="${SHARED_DIR}/jobs/pending"
mkdir -p "${PENDING_DIR}"

# ---------------------------------------------------------------------------
# Build args JSON array
# ---------------------------------------------------------------------------
read -ra ARGS_ARRAY <<< "${ARGS_STR}"
ARGS_JSON="$(python3 -c "import json,sys; print(json.dumps(sys.argv[1:]))" "${ARGS_ARRAY[@]+"${ARGS_ARRAY[@]}"}")"

# ---------------------------------------------------------------------------
# Generate job id and write spec
# ---------------------------------------------------------------------------
JOB_ID="$(python3 -c "import uuid; print(str(uuid.uuid4()))")"
OUTPUT="${PENDING_DIR}/${JOB_ID}.json"

python3 -c "
import json, sys
spec = {
    'id':         sys.argv[1],
    'agentId':    sys.argv[2],
    'scriptPath': sys.argv[3],
    'args':       json.loads(sys.argv[4]),
}
if sys.argv[5]:
    spec['notifyAgentId'] = sys.argv[6] if sys.argv[6] else sys.argv[2]
    spec['notifySubject'] = sys.argv[5]
print(json.dumps(spec, indent=2))
" \
    "${JOB_ID}" \
    "${AGENT_ID}" \
    "${SCRIPT_PATH}" \
    "${ARGS_JSON}" \
    "${NOTIFY_SUBJECT}" \
    "${NOTIFY_AGENT:-${AGENT_ID}}" > "${OUTPUT}"

echo "Job submitted: ${JOB_ID}"
echo "  Script : ${SCRIPT_PATH}"
echo "  Agent  : ${AGENT_ID}"
echo "  Log    : ${SHARED_DIR}/logs/bg-${JOB_ID}.log"
echo ""
echo "The daemon will pick it up on the next heartbeat (within 1 minute)."
