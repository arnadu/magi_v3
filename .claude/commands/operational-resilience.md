---
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git status:*), Bash(grep:*), Bash(find:*), Read, Glob, Grep
description: Review and update the operational resilience document — scan recent changes for new failure modes, confirm gap table is current
---

You are a senior engineer reviewing the operational resilience posture of MAGI V3.

PROJECT CONTEXT:

```
!`cat CLAUDE.md`
```

CURRENT OPERATIONAL RESILIENCE DOCUMENT:

```
!`cat docs/operational-resilience.md`
```

SPRINT DIFF (recent changes):

```
!`git log --no-decorate -20 --oneline`
```

```
!`git diff --name-only HEAD~10 2>/dev/null || git diff --name-only HEAD~5`
```

```
!`git diff HEAD~10 2>/dev/null || git diff HEAD~5`
```

---

Run the following checks in order. Report each result clearly.

## Check 1 — New components that need coverage

Scan the sprint diff for:
- New long-running processes or background services (new daemon loops, cron jobs, servers)
- New persistence layers (new MongoDB collections, new file stores, new external services)
- New external dependencies (new APIs, new cloud services, new infrastructure components)
- New IPC or inter-process communication paths

For each match: verify whether a corresponding row exists in `docs/operational-resilience.md`.

If a component is missing: draft a new table row with failure mode, effect, severity, current mitigation, and gap.

## Check 2 — Fixed gaps

Scan the sprint diff for code changes that close any of the known gaps (G-1 through G-6) listed in the Gap summary table. For each closed gap:
- Propose removing or updating the gap row in the Gap summary table
- Propose adding a row to the "Recently fixed" section

## Check 3 — New gaps

Based on the sprint diff, identify any new operational failure modes not yet in the document:
- What fails if the new component crashes or hangs?
- What fails if the new dependency is unavailable?
- What data is lost vs. what is preserved if the new component fails mid-operation?
- Is there a recovery path? Does it require operator action?

For each new gap: propose a new row in the relevant layer table and in the Gap summary.

## Check 4 — Recovery runbook currency

Check whether any new failure modes identified in checks 1–3 require a new recovery procedure in the Operator recovery runbook. If so, draft the procedure.

## Check 5 — "Recently fixed" section

Confirm whether the "Recently fixed" table is accurate and up to date based on the sprint diff. Propose any additions.

## Summary

Print a punch list:
- ✅ Coverage confirmed for all new components
- ⚠️ COVERAGE GAP for any new component or failure mode not yet documented, with the exact text to add to `docs/operational-resilience.md`
- ⚠️ STALE GAP for any gap that has been fixed but not removed from the document

For each gap: propose the exact edit to `docs/operational-resilience.md` so the update can be applied immediately.
