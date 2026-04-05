#!/usr/bin/env bash
# run-background/scripts/job-status.sh
#
# Check the status of a background job and tail its log.
#
# Usage:
#   bash job-status.sh <jobId>
#
# Environment:
#   SHARED_DIR   (required) — mission shared directory

set -euo pipefail

JOB_ID="${1:?Usage: job-status.sh <jobId>}"

if [[ -z "${SHARED_DIR:-}" ]]; then
    # Derive sharedDir from script location.
    # This script lives at: sharedDir/skills/_platform/run-background/scripts/job-status.sh
    SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
    SHARED_DIR="$(dirname "$(dirname "$(dirname "$(dirname "$SCRIPTS_DIR")")")")"
fi

PENDING_FILE="${SHARED_DIR}/jobs/pending/${JOB_ID}.json"
RUNNING_FILE="${SHARED_DIR}/jobs/running/${JOB_ID}.json"
STATUS_FILE="${SHARED_DIR}/jobs/status/${JOB_ID}.json"
LOG_FILE="${SHARED_DIR}/logs/bg-${JOB_ID}.log"

# Determine current state
if [[ -f "${STATUS_FILE}" ]]; then
    echo "=== Job status ==="
    cat "${STATUS_FILE}"
elif [[ -f "${RUNNING_FILE}" ]]; then
    echo "=== Job is RUNNING ==="
    cat "${RUNNING_FILE}"
elif [[ -f "${PENDING_FILE}" ]]; then
    echo "=== Job is PENDING (waiting for daemon heartbeat) ==="
    cat "${PENDING_FILE}"
else
    echo "Job ${JOB_ID} not found in pending/, running/, or status/"
    echo "  Pending: ${PENDING_FILE}"
    echo "  Running: ${RUNNING_FILE}"
    echo "  Status:  ${STATUS_FILE}"
    exit 1
fi

# Tail the log file if it exists
echo ""
if [[ -f "${LOG_FILE}" ]]; then
    echo "=== Last 20 lines of log (${LOG_FILE}) ==="
    tail -n 20 "${LOG_FILE}"
else
    echo "(No log file yet: ${LOG_FILE})"
fi
