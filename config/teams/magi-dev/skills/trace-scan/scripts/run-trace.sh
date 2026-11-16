#!/usr/bin/env bash
# Fetches the latest trace of the MAGI repository and publishes it to the
# mission. CI runs the trace on every push to main and publishes its reports
# (without the security results) to the repository's `trace` branch; this job,
# scheduled by the code reviewer, copies them to shared/analysis/ and builds
# each reviewer's to-do list. "New" means new since the scan this mission last
# fetched.
#
# Usage (schedule-job.sh passes both): run-trace.sh <shared dir> <workdir>
set -euo pipefail

SHARED_DIR="${1:?usage: run-trace.sh <shared dir> <workdir>}"
WORKDIR="${2:?usage: run-trace.sh <shared dir> <workdir>}"
export SHARED_DIR WORKDIR

SYNC="$(bash "$SHARED_DIR/skills/_team/repo-workspace/scripts/repo-sync.sh")"
echo "$SYNC"
CLONE="$(sed -n 's/^clone: //p' <<<"$SYNC")"
[ -d "$CLONE" ] || { echo "[trace-scan] no clone at '$CLONE'" >&2; exit 2; }

git -C "$CLONE" fetch --quiet --depth=1 origin trace || {
	echo "[trace-scan] the repository has no trace branch yet: CI publishes it after a push to main" >&2
	exit 3
}

PUBLISH="$SHARED_DIR/analysis"
mkdir -p "$PUBLISH"
[ -f "$PUBLISH/todo.json" ] && cp "$PUBLISH/todo.json" "$PUBLISH/.previous-todo.json"
for f in index.md operations.md writes.md invariants.md components.html \
	todo.json operations.json writes.json invariants.json entry-points.json; do
	git -C "$CLONE" show "FETCH_HEAD:$f" > "$PUBLISH/.$f.tmp"
	mv -f "$PUBLISH/.$f.tmp" "$PUBLISH/$f"
done
PREVIOUS=()
[ -f "$PUBLISH/.previous-todo.json" ] && PREVIOUS=(--previous "$PUBLISH/.previous-todo.json")
node "$CLONE/scripts/trace/todo.mjs" build "$PUBLISH" "$SHARED_DIR/team/coverage.json" "${PREVIOUS[@]}"
echo "[trace-scan] published the scan of $(sed -n 's/.*from commit `\([^`]*\)`.*/\1/p' "$PUBLISH/index.md" | head -1) to $PUBLISH"
