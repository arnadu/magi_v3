#!/usr/bin/env bash
# The trace of the MAGI repository, as a scheduled background job of the code
# reviewer: sync its clone, install dependencies when the lock file changed,
# install the pinned CodeQL, run `npm run trace`, publish the reports to
# shared/analysis/ and build each reviewer's to-do list.
#
# Usage (schedule-job.sh passes both): run-trace.sh <shared dir> <workdir>
set -euo pipefail

SHARED_DIR="${1:?usage: run-trace.sh <shared dir> <workdir>}"
WORKDIR="${2:?usage: run-trace.sh <shared dir> <workdir>}"
export SHARED_DIR WORKDIR

echo "[trace-scan] syncing the clone"
SYNC="$(bash "$SHARED_DIR/skills/_team/repo-workspace/scripts/repo-sync.sh")"
echo "$SYNC"
CLONE="$(sed -n 's/^clone: //p' <<<"$SYNC")"
[ -d "$CLONE" ] || { echo "[trace-scan] no clone at '$CLONE'" >&2; exit 2; }
cd "$CLONE"

LOCK="$(sha256sum package-lock.json | cut -c1-64)"
if [ "$(cat node_modules/.trace-scan-lock 2>/dev/null || true)" != "$LOCK" ]; then
	echo "[trace-scan] installing dependencies (lock file changed)"
	npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
	echo "$LOCK" > node_modules/.trace-scan-lock
fi

export CODEQL_HOME="$WORKDIR/.cache/codeql"
bash scripts/trace/install-codeql.sh

# The private output keeps the previous run, so new findings are marked.
OUT="$WORKDIR/analysis"
npm run --silent trace -- --out "$OUT"

PUBLISH="$SHARED_DIR/analysis"
mkdir -p "$PUBLISH"
for f in index.md operations.md writes.md security.md invariants.md components.html \
	todo.json operations.json writes.json security.json invariants.json entry-points.json; do
	cp "$OUT/$f" "$PUBLISH/.$f.tmp" && mv -f "$PUBLISH/.$f.tmp" "$PUBLISH/$f"
done
node scripts/trace/todo.mjs build "$PUBLISH" "$SHARED_DIR/team/coverage.json"
echo "[trace-scan] published to $PUBLISH: $(sed -n 's/^| Findings | \(.*\) |$/\1/p' "$PUBLISH/index.md") findings"
