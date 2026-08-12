---
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git status:*), Bash(find:*), Bash(wc:*), Bash(gh issue view:*), Read, Glob, Grep, Edit
description: Periodic code-structure review — measure file/function size drift, verify docs/code-structure.md is current, recommend decomposition
---

You are a senior engineer reviewing code structure health for MAGI V3 — file and function size,
and separation of concerns — following the triggers in CLAUDE.md's "Code Structure" section.

PROJECT CONTEXT:

```
!`cat CLAUDE.md`
```

CURRENT INVENTORY:

```
!`cat docs/code-structure.md`
```

SPRINT DIFF (recent changes):

```
!`git log --no-decorate -20 --oneline`
```

```
!`git diff --name-only HEAD~10 2>/dev/null || git diff --name-only HEAD~5`
```

---

Run the following checks in order. Report each result clearly.

## Check 1 — Size sweep

```
!`find packages -path "*/node_modules/*" -prune -o -path "*/dist/*" -prune -o -name "*.ts" -print -o -name "*.tsx" -print 2>/dev/null | xargs wc -l | sort -rn | head -25`
```

For any file over ~500 lines not already in `docs/code-structure.md`'s inventory: read it and
characterize what concerns it mixes, or confirm it's cohesive (one class with cleanly siloed
state, or a flat list of independent handlers) per the "judgment call" guidance in CLAUDE.md's
Code Structure section. Propose a new inventory row (File / Lines / Concerns mixed /
Decomposition risk / Status / Tracking issue).

## Check 2 — Function-length sweep

For each file already in the inventory (and any newly flagged in Check 1), identify the longest
function/method by reading the file. Report its name, line range, length, and whether it's a
"phases with shared state" god-function (decomposition candidate, per the ~80–100 line trigger)
or a "flat dispatch with short bodies" shape (not a concern despite length).

## Check 3 — Drift since last review

Compare each tracked file's current line count against the number recorded in
`docs/code-structure.md`. Flag any file that grew by more than ~10% since it was last measured —
sprint-after-sprint growth with no refactor checkpoint is itself a CLAUDE.md trigger, independent
of absolute size.

## Check 4 — Status accuracy

For each inventory row with a tracking issue and a status of "Planned" or "In progress": run
`gh issue view <N> --repo arnadu/magi_v3` and check its state. If the issue is closed, re-measure
the file/function before marking the row "Done" — closing the issue is not proof the
decomposition actually landed.

## Summary

Print a punch list:
- ✅ files/functions confirmed within norms, or accurately tracked in `docs/code-structure.md`
- ⚠️ NEW ENTRY — a file or function crossing a threshold and not yet tracked; give the exact row
  to add
- ⚠️ STALE ENTRY — a row whose status, line count, or risk assessment no longer matches reality
- ⚠️ DRIFT — a tracked file that grew significantly since its last recorded measurement

---

WRITE STEP (execute after the summary):

Apply every ⚠️ item directly to `docs/code-structure.md` using Edit — new rows, corrected line
counts, updated status — then report exactly what changed. Do not silently skip an update because
it seems minor; a stale inventory is worse than no inventory, since it's trusted without being
re-verified.
