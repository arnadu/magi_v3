#!/usr/bin/env bash
# add-comment.sh — add a comment to a GitHub Issue.
# Usage: add-comment.sh <issue-number> "<comment>"
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required (personal access token with repo scope)}"
: "${GITHUB_REPO:?GITHUB_REPO is required (e.g. arnadu/magi_v3)}"

NUMBER="${1:?issue number is required}"
COMMENT="${2:?comment body is required}"

PAYLOAD=$(node -e "process.stdout.write(JSON.stringify({ body: process.argv[1] }))" "$COMMENT")

curl -sf -X POST \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github.v3+json" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "https://api.github.com/repos/${GITHUB_REPO}/issues/${NUMBER}/comments" |
node -e "
const r = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
console.log('Comment added: ' + r.html_url);
"
