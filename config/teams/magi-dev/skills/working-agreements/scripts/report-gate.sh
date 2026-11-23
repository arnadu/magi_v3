#!/usr/bin/env bash
# The report gate, run as a scheduled job (schedule-job.sh): brings the clone up to
# date, then checks every new or changed report against it (report-gate.py).
#
# Usage (schedule-job.sh passes both): report-gate.sh <shared dir> <workdir>
set -euo pipefail

SHARED_DIR="${1:?usage: report-gate.sh <shared dir> <workdir>}"
WORKDIR="${2:?usage: report-gate.sh <shared dir> <workdir>}"
export SHARED_DIR WORKDIR

SYNC="$(bash "$SHARED_DIR/skills/_team/repo-workspace/scripts/repo-sync.sh")"
CLONE="$(sed -n 's/^clone: //p' <<<"$SYNC")"
[ -d "$CLONE" ] || { echo "[report-gate] no clone at '$CLONE'" >&2; exit 2; }
# The reports cite main as it is now (and the commits they review): checked in a
# worktree of the gate's own, so the author's clone and its work are never touched.
TREE="$WORKDIR/report-gate-tree"
if [ -d "$TREE/.git" ] || [ -f "$TREE/.git" ]; then
	git -C "$TREE" checkout --quiet --detach origin/main
else
	git -C "$CLONE" worktree add --quiet --detach "$TREE" origin/main
fi

python3 -I "$SHARED_DIR/skills/_team/working-agreements/scripts/report-gate.py" "$SHARED_DIR" "$TREE"
