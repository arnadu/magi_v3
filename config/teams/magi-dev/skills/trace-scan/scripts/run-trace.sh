#!/usr/bin/env bash
# Fetches the latest trace of the MAGI repository and publishes it to the
# mission. CI runs the trace on every push to main and publishes its reports
# (without the security results) to the repository's `trace` branch; this job,
# scheduled by the code reviewer, copies them to shared/analysis/ and builds
# each reviewer's view of its findings. "New" means new since the scan this
# mission last fetched.
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
# The files of the earlier to-do layout: its last scan becomes the previous one.
if [ -f "$PUBLISH/todo.json" ]; then
	mv -f "$PUBLISH/todo.json" "$PUBLISH/.previous-findings.json"
	rm -f "$PUBLISH"/todo-*.md "$PUBLISH/.todo-build.json" "$PUBLISH/.previous-todo.json"
elif [ -f "$PUBLISH/findings.json" ]; then
	cp "$PUBLISH/findings.json" "$PUBLISH/.previous-findings.json"
fi
for f in index.md operations.md writes.md invariants.md components.html \
	findings.json operations.json writes.json invariants.json entry-points.json; do
	git -C "$CLONE" show "FETCH_HEAD:$f" > "$PUBLISH/.$f.tmp"
	mv -f "$PUBLISH/.$f.tmp" "$PUBLISH/$f"
done
PREVIOUS=()
[ -f "$PUBLISH/.previous-findings.json" ] && PREVIOUS=(--previous "$PUBLISH/.previous-findings.json")
node "$CLONE/scripts/trace/decisions.mjs" build "$PUBLISH" "$SHARED_DIR/team/coverage.json" "${PREVIOUS[@]}"
echo "[trace-scan] published the scan of $(sed -n 's/.*from commit `\([^`]*\)`.*/\1/p' "$PUBLISH/index.md" | head -1) to $PUBLISH"
