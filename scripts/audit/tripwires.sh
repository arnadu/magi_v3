#!/usr/bin/env bash
# Repo-wide tripwires: cheap, deterministic, whole-repo (not diff-scoped). Each check greps for a
# pattern that past incidents showed to be dangerous or to drift, and fails unless every hit is
# allowlisted in scripts/audit/tripwires.allow. It is a tripwire, not a proof of absence: text
# matching has false positives (allowlist them with a reason) and false negatives (it cannot follow
# data flow — that is what /sprint-audit's boundary auditor is for).
#
# Usage:
#   bash scripts/audit/tripwires.sh            # scan; exit 1 on any non-allowlisted hit
#   bash scripts/audit/tripwires.sh --selftest # prove every check still matches its planted sample
#   MAXHITS=50 bash scripts/audit/tripwires.sh # show more hits per check (default 8)
#
# Allowlist line formats (tripwires.allow):
#   <check-id> <regex>        # reason (owner, date)   -- drops hits whose "file:line:text" matches
#   <check-id> maxcount=<N>   # reason (owner, date)   -- for noisy checks: fail only above N hits
# Entries may be tightened or removed, never loosened, without a reason in the commit.
#
# Deliberately plain GNU grep: an earlier version used rg, which is a shell function rather than a
# binary in some environments, so `timeout rg` found nothing and every check passed vacuously.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

ALLOW=scripts/audit/tripwires.allow
SELFTEST_DIR=scripts/audit/selftest
MAXHITS=${MAXHITS:-8}
fail=0
selftest=0
[ "${1:-}" = "--selftest" ] && selftest=1

# scan <pattern> <paths...>: file:line:text, tests and build output excluded.
scan() {
	local pattern=$1
	shift
	grep -rnE --binary-files=without-match \
		--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=tests --exclude-dir=test \
		--exclude='*.test.ts' --exclude='*.test.tsx' --exclude='*.d.ts' \
		-e "$pattern" "$@" 2>/dev/null || true
}

# check <id> <description> <pattern> <paths...>
check() {
	local id=$1 desc=$2 pattern=$3
	shift 3
	local hits maxcount=""
	if [ "$selftest" = 1 ]; then
		hits=$(scan "$pattern" "$SELFTEST_DIR")
		if [ -z "$hits" ]; then
			echo "SELFTEST FAIL: $id matched nothing in $SELFTEST_DIR — the check is blind"
			fail=1
		fi
		return
	fi
	hits=$(scan "$pattern" "$@")
	if [ -f "$ALLOW" ]; then
		while read -r aid apat _; do
			[ "$aid" = "$id" ] || continue
			case "$apat" in
				maxcount=*) maxcount=${apat#maxcount=} ;;
				*) hits=$(printf '%s\n' "$hits" | grep -Ev -- "$apat" || true) ;;
			esac
		done < <(grep -v '^[[:space:]]*#' "$ALLOW" | grep -v '^[[:space:]]*$')
	fi
	local n
	n=$(printf '%s\n' "$hits" | grep -c . || true)
	if [ -n "$maxcount" ]; then
		if [ "$n" -gt "$maxcount" ]; then
			fail=1
			echo "== $id: $n hits > allowed $maxcount — $desc"
			printf '%s\n' "$hits" | head -"$MAXHITS"
		fi
	elif [ "$n" -gt 0 ]; then
		fail=1
		echo "== $id ($n) $desc"
		printf '%s\n' "$hits" | head -"$MAXHITS"
	fi
}

W=packages/agent-runtime-worker/src
CP=packages/control-plane/src
CK=packages/cockpit/src

# T1 ENV1: tenant-supplied config must never reach the server environment.
check T1-env-in-config "process.env read inside agent-config (tenant-supplied input must never reach env)" \
	'process\.env' packages/agent-config/src
# T2 XSS1/LEG-XSS: raw HTML sinks need escaping of & < > " ' and a URL-scheme allow-list.
check T2-html-sinks "raw HTML sink (escape and scheme-check before use)" \
	'dangerouslySetInnerHTML|\.innerHTML[[:space:]]*=|insertAdjacentHTML' $CK
# T3 LEG-XSS: href built from data without a scheme allow-list.
check T3-href-from-data "href built from data (needs scheme allow-list)" \
	'href="\$|href=\\"\$' $CK
# T4 TF1/MS1/RS2/AR1: path joins with a dynamic segment in daemon-identity file code.
check T4-path-join "join/resolve with dynamic segment in daemon/monitor file code; must go through resolveInside()" \
	'(path\.)?(join|resolve)\([^)]*(\.path|\.name|relPath|params\.|query\.|body\.)' \
	$W/monitor-routes $W/daemon-boot $W/tools $W/artifacts.ts
# T5 child processes: confirm an explicit minimal env.
check T5-spawn-env "child process: confirm explicit minimal env" \
	'(execFile|execFileSync|spawn|spawnSync|execSync|exec)\(' $W $CP
# T6 GIT1: every daemon git call goes through safe-git.ts.
check T6-git "git subprocess outside safe-git.ts (hooks/fsmonitor/global config must be neutralised)" \
	"['\"]git['\"]|git -C" $W $CP
# T7 C1: Express 4 async handlers need a rejection wrapper.
check T7-async-handler "async Express 4 handler without a rejection wrapper" \
	'router\.(get|post|put|patch|delete)\([^,]+,[[:space:]]*(async|requireAuth[^,]*,[[:space:]]*async)' $CP
# T8 swallowed errors.
check T8-empty-catch "empty catch (log operation, input and consequence, or say why ignoring is safe)" \
	'catch[[:space:]]*(\([^)]*\))?[[:space:]]*\{[[:space:]]*\}' packages/*/src
# T8b swallowed promise rejections: same rule as T8.
check T8b-swallowed-promise "promise rejection swallowed (log operation, input and consequence, or say why ignoring is safe)" \
	'\.catch\(\(\)[[:space:]]*=>[[:space:]]*\{\}\)' packages/*/src
# T9 type escape hatches (biome-ignore already requires a reason by syntax).
check T9-escape-hatches "type escape hatch (each needs a one-line constraint)" \
	'@ts-ignore|@ts-expect-error|as any\b|as unknown as' packages/*/src
# T10 LM1: spend cap must not be optional in the schema.
check T10-optional-cap "spend cap optional in schema" \
	'maxCostUsd.*\.optional\(\)' packages/agent-config/src
# T11 INV-9: history in comments (sprint numbers, running changelog). One-line incident
# references with a date are allowed; "Sprint N" bookkeeping is not.
check T11-comment-history "sprint/finding history in comments (state the constraint; link an ADR in one line)" \
	'^[[:space:]]*(//|\*|/\*|#).*(Sprints? [0-9]+|\bCR-0[0-9]|\bF-0[0-9][0-9]|issue #[0-9]+)' packages/*/src
# T12 MBX1: mailbox documents are written through one helper.
check T12-raw-mailbox-insert "raw mailbox insertOne (use the shared mailbox writer)" \
	'collection\("mailbox"\)[[:space:]]*\.insertOne|collection<[^>]*>\("mailbox"\)[[:space:]]*\.insertOne' $W $CP
# T13 R-15: a collection is reached through storedCollection()/COLLECTION_NAMES, never a name literal.
check T13-collection-literal "MongoDB collection named by a string literal (use storedCollection or COLLECTION_NAMES)" \
	'\.collection(<[^>]*>)?\([[:space:]]*["'"'"']' $W $CP packages/agent-config/src
# LLM-facing text naming tools/scripts: handled by contract tests (llm-text.*.test), not here.

if [ "$selftest" = 1 ]; then
	[ "$fail" = 0 ] && echo "tripwires selftest: every check matches its planted sample"
fi
exit $fail
