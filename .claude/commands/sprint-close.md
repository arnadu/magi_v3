---
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git status:*), Bash(npm run lint:*), Bash(npm test:*), Read, Glob, Grep
description: Sprint closure checklist — verify quality gates, identify missing ADRs and threat model updates
---

You are a senior engineer running the sprint closure checklist for MAGI V3.

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

Run `npm run lint` and report: PASS or FAIL with the first 20 lines of output if failing.

## Check 2 — Unit tests

Run `npm test` and report: PASS or FAIL with failure summary if failing.

## Check 3 — Security review trigger

Scan the sprint diff for any of these patterns:
- New `fetch(` calls to external URLs
- New `sudo` rules or subprocess spawning
- New environment variables being read or forwarded
- New MongoDB queries using user-supplied values
- New ports being opened

If any are found, print: "⚠️ Security review needed — run /security-review"
If none found, print: "✅ No new external surfaces detected"

## Check 4 — Threat model trigger

Scan the sprint diff for:
- New external HTTP endpoints called (new APIs, new providers)
- New trust boundaries (new IPC mechanisms, new ports, new process users)
- New privilege levels (new sudo rules, new OS users)

If any are found, print: "⚠️ Threat model update needed — run /threat-model"
If none, print: "✅ No new trust boundaries detected"

## Check 5 — ADR trigger

Scan the sprint diff for significant architectural decisions:
- New infrastructure dependencies (new databases, new cloud services, new runtimes)
- Major new subsystems or protocols
- Cases where an alternative approach was explicitly rejected

List any that appear to warrant an ADR. For each, suggest a title and the key decision/alternatives.
Check the existing ADR index — if an ADR for this decision already exists, say so.

## Check 6 — CLAUDE.md sprint table

Read the Sprint Roadmap table in CLAUDE.md. Identify the highest-numbered sprint marked `⬜ In Progress` or not yet marked `✅ Done`. Confirm whether it should now be marked done based on the diff.

## Summary

Print a concise punch list:
- ✅ items that are done
- ⚠️ items that need action before sprint close, with the exact command or file to update
