#!/usr/bin/env bash
# close-issue.sh — close a GitHub Issue with an optional reason comment.
# Usage: close-issue.sh <issue-number> "<closing reason>"
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required (personal access token with repo scope)}"
: "${GITHUB_REPO:?GITHUB_REPO is required (e.g. arnadu/magi_v3)}"

NUMBER="${1:?issue number is required}"
REASON="${2:-}"

if [ -n "$REASON" ]; then
  PAYLOAD=$(node -e "process.stdout.write(JSON.stringify({ body: process.argv[1] }))" "$REASON")
  curl -sf -X POST \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Accept: application/vnd.github.v3+json" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    "https://api.github.com/repos/${GITHUB_REPO}/issues/${NUMBER}/comments" > /dev/null
fi

curl -sf -X PATCH \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github.v3+json" \
  -H "Content-Type: application/json" \
  -d '{"state":"closed"}' \
  "https://api.github.com/repos/${GITHUB_REPO}/issues/${NUMBER}" |
node -e "
const r = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
console.log('Closed #' + r.number + ': ' + r.html_url);
"
