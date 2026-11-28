#!/usr/bin/env bash
# One alert-triage run, as a background job: the items from the open alerts and the watched
# guards, then the review pipeline over them, highest priority first, within today's budget. State
# stays in the agent's own workdir (private); its counts are published to
# $SHARED_DIR/status/alert-triage.json (publish_status.py).
#
#   run_triage.sh <shared-dir> <workdir> [--notify <agent>] [--max-usd-per-day <usd>]
#                 [--max-usd-per-item <usd>] [--max-calls <n>] [--max-minutes <n>]
#
# --max-usd-per-day (default 2): no investigation starts once today's spend (UTC) reaches it. It,
#   not the schedule, sets the pace: run the job hourly and the day's budget is spent on the
#   highest-priority items first.
# --max-usd-per-item (default 1): what all of one alert's investigations (the first, two
#   confirmations, the refuter) may cost together; past it the alert is set aside as over-budget.
# --max-minutes (default 12): no investigation starts after it, so the run ends (and is recorded)
#   before the job's 30-minute limit. --max-calls (default 40): investigations per run.
# --notify <agent>: mails the agent only when there is work (notify_triage.py).
# What a run does not reach is deferred; each verdict is saved as it is reached.
set -euo pipefail
SHARED_DIR="$1"
WORKDIR="$2"
shift 2
MAX_CALLS=40
MAX_MINUTES=12
MAX_USD_PER_DAY=2
MAX_USD_PER_ITEM=1
NOTIFY=""
# A bare number in third place is max-calls: the form this script took before its options.
if [[ $# -gt 0 && "$1" =~ ^[0-9]+$ ]]; then
  MAX_CALLS="$1"
  shift
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --notify) NOTIFY="$2"; shift 2 ;;
    --max-usd-per-day) MAX_USD_PER_DAY="$2"; shift 2 ;;
    --max-usd-per-item) MAX_USD_PER_ITEM="$2"; shift 2 ;;
    --max-calls) MAX_CALLS="$2"; shift 2 ;;
    --max-minutes) MAX_MINUTES="$2"; shift 2 ;;
    *) echo "run_triage.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
SK="$SHARED_DIR/skills/_team/alert-triage"
OUT="$WORKDIR/review"
mkdir -p "$OUT"
chmod 700 "$OUT"
python3 "$SK/scripts/produce_items.py" --reference magi-v3 --out "$OUT/items.jsonl"
python3 "$SHARED_DIR/skills/_platform/review-pipeline/scripts/review.py" \
  --items "$OUT/items.jsonl" --kinds "$SK/kinds" --state "$OUT/state" \
  --reference magi-v3 --max-calls "$MAX_CALLS" --max-minutes "$MAX_MINUTES" \
  --max-usd-per-day "$MAX_USD_PER_DAY" --max-usd-per-item "$MAX_USD_PER_ITEM"
# Counts only, for the daily brief; the state itself stays private.
python3 "$SK/scripts/publish_status.py" "$OUT/state" "$OUT/items.jsonl" \
  "$SHARED_DIR/reports/security/register.md" "$SHARED_DIR/status/alert-triage.json"
if [[ -n "$NOTIFY" ]]; then
  python3 "$SK/scripts/notify_triage.py" "$OUT/state" "$NOTIFY"
fi
