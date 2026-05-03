---
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git status:*), Bash(npm run lint:*), Bash(npm test:*), Read, Glob, Grep
description: Sprint closure checklist — verify quality gates, identify missing ADRs and threat model updates
---

You are a senior engineer running the sprint closure confirmation pass for MAGI V3.

IMPORTANT FRAMING: Sprint close is a confirmation pass, not where quality work happens.
Each check below should already be satisfied. A failure means a process gap — note it,
fix it, and address the habit in the next sprint. Do not present fixing a gap as "completing"
the sprint; present it as catch-up work.

PROJECT CONTEXT:

```
!`cat CLAUDE.md`
```

CURRENT THREAT MODEL:

```
!`cat docs/security/threat-model.md`
```

CURRENT ADR INDEX:

```
!`ls docs/adr/`
```

SPRINT DIFF (all changes since last sprint tag or merge base):

```
!`git log --no-decorate -20 --oneline`
```

```
!`git diff --name-only origin/HEAD~10...HEAD 2>/dev/null || git diff --name-only HEAD~10`
```

---

Run the following checks in order. Report each result clearly.

## Check 1 — Lint

Run `npm run lint` and report: PASS or FAIL.
On FAIL: show the first 20 lines of output, then note "⚠️ PROCESS GAP — lint should pass before any commit (pre-commit hook enforces this)."

## Check 2 — Unit tests

Run `npm test` and report: PASS or FAIL with failure summary if failing.

## Check 3 — Security surface review

Scan the sprint diff for:
- New `fetch(` calls to external URLs
- New `sudo` rules or subprocess spawning with env forwarding
- New environment variables being read or forwarded to child processes
- New MongoDB queries using externally supplied values
- New ports being opened or new public endpoints

For each match: confirm whether `/security-review` was already run for it (look in git log for a "security-review" commit or `docs/security/findings.md` update during this sprint).

If coverage is missing: "⚠️ Security review needed — run /security-review"
If all surfaces are covered: "✅ Security surfaces reviewed"

## Check 4 — Threat model currency

Scan the sprint diff for:
- New external HTTP endpoints (new APIs, new providers)
- New trust boundaries (new IPC ports, new process users, new inter-service calls)
- New privilege levels (new `sudo` rules, new OS users, new Fly machine roles)

For each match: confirm whether `docs/security/threat-model.md` was updated in the same sprint.

If threat model is stale: "⚠️ Threat model update needed — run /threat-model"
If current: "✅ Threat model is current"

## Check 5 — ADR coverage

Scan the sprint diff for significant architectural decisions:
- New infrastructure dependencies (databases, cloud services, runtimes, protocols)
- Cases where a concrete alternative was weighed and rejected
- Major new subsystems

For each candidate: check whether an ADR exists in `docs/adr/`. If not, suggest a title and the key decision/alternatives.
If a superseded design was removed: check whether the relevant ADR is marked SUPERSEDED.

## Check 6 — CLAUDE.md sprint table

Read the Sprint Roadmap table in CLAUDE.md. Identify the highest-numbered sprint not yet marked `✅ Done`. Confirm whether it should now be marked done based on the diff, and give the one-line summary to use.

## Summary

Print a concise punch list:
- ✅ items already done (most items should be here)
- ⚠️ PROCESS GAP items that need catch-up work, with the exact command or file to update
- For each gap: note which habit (lint discipline, security trigger, threat model trigger, ADR discipline) should have caught it earlier
