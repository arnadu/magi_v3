#!/usr/bin/env bash
# Semgrep, with CI's rule sets, over the files under packages/ that differ from origin/main:
# run before a push (.githooks/pre-push) so a finding is fixed before CI sees it. CI's SAST job
# still scans everything; without a local semgrep this only warns.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if ! command -v semgrep >/dev/null 2>&1; then
	echo "[semgrep-changed] semgrep is not installed: skipped (CI's SAST job still runs). pip install semgrep to check before pushing."
	exit 0
fi

base=$(git merge-base HEAD origin/main 2>/dev/null || git rev-parse HEAD~1)
mapfile -t files < <(
	{ git diff --name-only --diff-filter=ACMR "$base" -- packages/; git ls-files --others --exclude-standard -- packages/; } |
		sort -u | while read -r f; do [ -f "$f" ] && echo "$f"; done
)
if [ "${#files[@]}" -eq 0 ]; then
	echo "[semgrep-changed] no changed files under packages/"
	exit 0
fi
echo "[semgrep-changed] scanning ${#files[@]} changed file(s) with CI's rules…"
semgrep scan --config p/default --config scripts/security/semgrep/ --error --quiet "${files[@]}"
