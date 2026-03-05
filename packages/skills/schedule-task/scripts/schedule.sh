#!/usr/bin/env bash
# schedule-task/scripts/schedule.sh
#
# Register a recurring scheduled message for this mission.
# Writes a JSON spec file to sharedDir/schedules/<label>.json.
# The daemon picks this up on its next heartbeat and upserts it into the
# scheduled_messages collection. The entry is automatically re-armed after
# each delivery so the schedule recurs indefinitely.
#
# Re-running with the same label updates the schedule — safe to call multiple times.
#
# Usage:
#   bash schedule.sh <label> <to> <cron> <subject> <body>
#
# Arguments:
#   label    Unique name for this schedule (e.g. "daily-brief"). Re-using overwrites.
#   to       Comma-separated agent ids (e.g. "lead-analyst" or "lead-analyst,economist")
#   cron     Standard 5-field cron expression (e.g. "0 6 * * 1-5" for Mon-Fri 06:00)
#   subject  Message subject line
#   body     Message body
#
# Example:
#   bash schedule.sh "daily-brief" "lead-analyst" "0 6 * * 1-5" \
#     "[task] Daily cycle — begin" \
#     "The daily research cycle begins now. Task your team and produce the morning brief."

set -euo pipefail

LABEL="${1:?Usage: schedule.sh <label> <to> <cron> <subject> <body>}"
TO="${2:?Missing argument: to (comma-separated agent ids)}"
CRON="${3:?Missing argument: cron (e.g. \"0 6 * * 1-5\")}"
SUBJECT="${4:?Missing argument: subject}"
BODY="${5:?Missing argument: body}"

# ---------------------------------------------------------------------------
# Derive sharedDir from this script's location.
# This script lives at: sharedDir/skills/_platform/schedule-task/scripts/schedule.sh
# Parent chain:         scripts/ → schedule-task/ → _platform/ → skills/ → sharedDir/
# ---------------------------------------------------------------------------
SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
SHARED_DIR="$(dirname "$(dirname "$(dirname "$(dirname "$SCRIPTS_DIR")")")")"
SCHEDULES_DIR="${SHARED_DIR}/schedules"

mkdir -p "${SCHEDULES_DIR}"

# ---------------------------------------------------------------------------
# Convert comma-separated "to" list to a JSON array.
# e.g. "lead-analyst,economist" → ["lead-analyst","economist"]
# ---------------------------------------------------------------------------
IFS=',' read -ra TO_ARRAY <<< "${TO}"
TO_JSON="["
FIRST=true
for AGENT in "${TO_ARRAY[@]}"; do
    AGENT="$(echo "${AGENT}" | xargs)"  # trim whitespace
    if [ "${FIRST}" = true ]; then
        TO_JSON="${TO_JSON}\"${AGENT}\""
        FIRST=false
    else
        TO_JSON="${TO_JSON},\"${AGENT}\""
    fi
done
TO_JSON="${TO_JSON}]"

# ---------------------------------------------------------------------------
# Write the schedule spec file.
# The daemon reads this and upserts into scheduled_messages.
# ---------------------------------------------------------------------------
OUTPUT="${SCHEDULES_DIR}/${LABEL}.json"

# Use printf to safely handle special characters in SUBJECT and BODY.
# jq would be cleaner but we cannot assume it is installed in the agent environment.
python3 -c "
import json, sys
spec = {
    'label': sys.argv[1],
    'to': json.loads(sys.argv[2]),
    'cron': sys.argv[3],
    'subject': sys.argv[4],
    'body': sys.argv[5],
}
print(json.dumps(spec, indent=2))
" "${LABEL}" "${TO_JSON}" "${CRON}" "${SUBJECT}" "${BODY}" > "${OUTPUT}"

echo "Schedule registered: ${OUTPUT}"
echo "  Label   : ${LABEL}"
echo "  To      : ${TO}"
echo "  Cron    : ${CRON}"
echo "  Subject : ${SUBJECT}"
echo ""
echo "The daemon will import this schedule on its next heartbeat (within 1 minute)."
