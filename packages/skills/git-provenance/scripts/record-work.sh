#!/usr/bin/env bash
# record-work.sh — stage and commit files to the mission git repository.
#
# Usage:
#   record-work.sh <agent-id> <commit-message> <file1> [file2 ...]
#
# The repo is already initialised by workspace-manager.provision().
# This script only stages and commits — it never runs git init.

set -euo pipefail

AGENT_ID="${1:?agent-id required}"
COMMIT_MSG="${2:?commit-message required}"
shift 2

if [ "$#" -eq 0 ]; then
  echo "Error: at least one file path is required" >&2
  exit 1
fi

FILES=("$@")

# Locate the git repo root from the first file's directory.
FIRST_DIR="$(dirname "${FILES[0]}")"
REPO_ROOT="$(git -C "$FIRST_DIR" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Error: ${FILES[0]} is not inside a git repository." >&2
  echo "workspace-manager.provision() should have run git init on the shared folder." >&2
  exit 1
}

# Stage specified files.
for file in "${FILES[@]}"; do
  git -C "$REPO_ROOT" add -- "$file"
done

# Commit with agent identity as both author and committer.
GIT_AUTHOR_NAME="$AGENT_ID" \
GIT_AUTHOR_EMAIL="${AGENT_ID}@magi" \
GIT_COMMITTER_NAME="$AGENT_ID" \
GIT_COMMITTER_EMAIL="${AGENT_ID}@magi" \
  git -C "$REPO_ROOT" commit -m "$COMMIT_MSG"

COMMIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"

# Append a structured entry to ledger.jsonl for machine-readable querying.
# node JSON.stringify handles all control characters (newlines, tabs, etc.) correctly.
LEDGER="$REPO_ROOT/ledger.jsonl"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

node -e "
const e = JSON.stringify;
process.stdout.write(
  '{\"sha\":' + e(process.argv[1]) +
  ',\"agent\":' + e(process.argv[2]) +
  ',\"message\":' + e(process.argv[3]) +
  ',\"timestamp\":' + e(process.argv[4]) +
  '}\n'
)" "$COMMIT_SHA" "$AGENT_ID" "$COMMIT_MSG" "$TIMESTAMP" >> "$LEDGER"

echo "Committed: $COMMIT_SHA"
echo "Message:   $COMMIT_MSG"
printf "Files:     %s\n" "${FILES[@]}"
