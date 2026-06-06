#!/usr/bin/env bash
# create-issue.sh — create a GitHub Issue.
# Usage: create-issue.sh "<title>" "<body>" "<label1,label2>"
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required (personal access token with repo scope)}"
: "${GITHUB_REPO:?GITHUB_REPO is required (e.g. arnadu/magi_v3)}"

TITLE="${1:?title is required}"
BODY="${2:?body is required}"
LABELS="${3:-}"

PAYLOAD=$(node -e "
const labels = process.argv[3] ? process.argv[3].split(',').map(s => s.trim()).filter(Boolean) : [];
process.stdout.write(JSON.stringify({ title: process.argv[1], body: process.argv[2], labels }));
" "$TITLE" "$BODY" "$LABELS")

curl -sf -X POST \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github.v3+json" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "https://api.github.com/repos/${GITHUB_REPO}/issues" |
node -e "
const r = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
console.log('Created #' + r.number + ': ' + r.html_url);
"
