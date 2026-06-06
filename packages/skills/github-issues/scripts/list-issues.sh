#!/usr/bin/env bash
# list-issues.sh — list open GitHub Issues, optionally filtered by label.
# Usage: list-issues.sh [label]
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required (personal access token with repo scope)}"
: "${GITHUB_REPO:?GITHUB_REPO is required (e.g. arnadu/magi_v3)}"

LABEL="${1:-}"
QS="state=open&per_page=50"
[ -n "$LABEL" ] && QS="${QS}&labels=${LABEL}"

curl -sf \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPO}/issues?${QS}" |
node -e "
const issues = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
if (issues.length === 0) { console.log('(no open issues)'); process.exit(0); }
issues.forEach(i => {
  const labels = i.labels.map(l => l.name).join(', ') || '(no labels)';
  const first = (i.body || '').split('\n')[0].slice(0, 120);
  console.log('#' + i.number + ' [' + labels + '] ' + i.title);
  if (first) console.log('  ' + first);
});
"
