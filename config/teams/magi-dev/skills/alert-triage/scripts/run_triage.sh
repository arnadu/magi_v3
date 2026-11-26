#!/usr/bin/env bash
# One alert-triage run, as a background job: the items from the open alerts and the watched
# guards, then the review pipeline over them. State stays in the agent's own workdir (private).
#
#   run_triage.sh <shared-dir> <workdir> [max-calls]
set -euo pipefail
SHARED_DIR="$1"
WORKDIR="$2"
MAX_CALLS="${3:-40}"
SK="$SHARED_DIR/skills/_team/alert-triage"
OUT="$WORKDIR/review"
mkdir -p "$OUT"
chmod 700 "$OUT"
python3 "$SK/scripts/produce_items.py" --reference magi-v3 --out "$OUT/items.jsonl"
python3 "$SHARED_DIR/skills/_platform/review-pipeline/scripts/review.py" \
  --items "$OUT/items.jsonl" --kinds "$SK/kinds" --state "$OUT/state" \
  --reference magi-v3 --max-calls "$MAX_CALLS"
