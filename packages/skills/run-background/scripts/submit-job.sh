#!/usr/bin/env bash
# run-background/scripts/submit-job.sh
#
# Submit a one-shot background script for execution by the daemon.
# Writes a job spec to sharedDir/jobs/pending/<jobId>.json.
# The daemon picks it up on its next heartbeat (within 1 minute).
#
# Usage:
#   bash submit-job.sh \
#     --script   <abs-path-to-script> \
#     --agent    <agentId> \
#     [--args    "<space-separated-args>"] \
#     [--notify-subject "<text>"] \
#     [--notify-agent   <agentId>]
#
# Environment:
#   SHARED_DIR   (required) — mission shared directory
#   LINUX_USER   (optional) — override the linux user to run as

set -euo pipefail

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------
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

if [[ -z "${SCRIPT_PATH}" || -z "${AGENT_ID}" ]]; then
    echo "Usage: submit-job.sh --script <path> --agent <agentId> [--args '...'] [--notify-subject '...']" >&2
    exit 1
fi

if [[ -z "${SHARED_DIR:-}" ]]; then
    echo "Error: SHARED_DIR environment variable is required" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Derive sharedDir from this script's location if SHARED_DIR not set.
# This script lives at: sharedDir/skills/_platform/run-background/scripts/submit-job.sh
# ---------------------------------------------------------------------------
SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
# _platform/run-background/scripts → _platform/run-background → _platform → skills → sharedDir
SHARED_DIR="${SHARED_DIR:-$(dirname "$(dirname "$(dirname "$(dirname "$SCRIPTS_DIR")")")")}"

PENDING_DIR="${SHARED_DIR}/jobs/pending"
mkdir -p "${PENDING_DIR}"

# ---------------------------------------------------------------------------
# Look up linuxUser from team YAML or fallback to LINUX_USER env var.
# For simplicity, trust LINUX_USER env var if provided; otherwise use whoami.
# ---------------------------------------------------------------------------
LINUX_USER="${LINUX_USER:-$(whoami)}"

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
    'id':          sys.argv[1],
    'agentId':     sys.argv[2],
    'linuxUser':   sys.argv[3],
    'scriptPath':  sys.argv[4],
    'args':        json.loads(sys.argv[5]),
}
if sys.argv[6]:
    spec['notifyAgentId'] = sys.argv[7] if sys.argv[7] else sys.argv[2]
    spec['notifySubject'] = sys.argv[6]
print(json.dumps(spec, indent=2))
" \
    "${JOB_ID}" \
    "${AGENT_ID}" \
    "${LINUX_USER}" \
    "${SCRIPT_PATH}" \
    "${ARGS_JSON}" \
    "${NOTIFY_SUBJECT}" \
    "${NOTIFY_AGENT:-${AGENT_ID}}" > "${OUTPUT}"

echo "Job submitted: ${JOB_ID}"
echo "  Script : ${SCRIPT_PATH}"
echo "  Agent  : ${AGENT_ID} (linux user: ${LINUX_USER})"
echo "  Log    : ${SHARED_DIR}/logs/bg-${JOB_ID}.log"
echo ""
echo "The daemon will pick it up on the next heartbeat (within 1 minute)."
