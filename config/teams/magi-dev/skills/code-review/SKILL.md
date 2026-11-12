---
name: code-review
description: Per-change review of the commits since your cursor — confirm CI was green, then judge what tools can't (correctness, failure handling, design, data-model integrity, tests, operability, performance) against the quality model, with labelled, refuted findings and a hand-off block.
---

# Code review (per change)

You review every change to the main branch. Tools already gate style, types, size, complexity,
known dangerous patterns and coverage floors (`quality-model`, "What is already enforced"); you
don't redo their work. You spend your effort on what only judgement finds. Security is appsec's
lens: note anything security-relevant under "For appsec" and leave the verdict to them.

## Procedure

1. **Sync and list** (`repo-workspace`) with `--lens code`. No commits: note it in your mental
   map and stop.
2. **CI first.** `python3 $SHARED_DIR/skills/_team/repo-workspace/scripts/ci-status.py <sha> ...`
   for the commits in the batch (at most ~10 per call: 60 requests an hour without a credential).
   A red commit on main is a blocking `issue` whatever its content: name the failed check. A
   `no-ci` commit only touched paths CI ignores; check that this was right.
3. **Read each commit as a whole**: the message, the diff, and enough of the surrounding code to
   know the callers and the data. Does it do what the message says, completely?
4. **Judge against the quality model**, judgement criteria first:
   - **Q1 correctness**: missed cases (empty, missing, duplicate, concurrent, retried, after a
     crash), wrong units, off-by-one, wrong comparison;
   - **Q2 failure handling**: errors swallowed or logged without operation, input and
     consequence; external calls without timeout and abort; multi-step writes that a crash
     would leave half done (atomic or compare-and-set?); background loops that can overlap,
     hang or die silently;
   - **Q5 data-model integrity**: a new local shape for a stored collection; a dotted path as a
     raw string; a changed stored shape without a migration or tolerant reader and a test;
   - **Q7 tests**: is there a test that fails without this change? Does it assert the behaviour
     or only that the code runs? Bug fixes need a failing-first test;
   - **Q4 design**: does the change put logic where it belongs, reuse the house mechanism
     (search for an existing helper before accepting a new one), keep dependency direction?
   - **Q9 operability** and **Q10 performance**: new failure modes documented in
     `docs/operational-resilience.md`? Unbounded growth, queries in loops?
   - **house rules**: the root `CLAUDE.md` "Working rules" and the package `CLAUDE.md`
     conventions, quoted when broken.
5. **What is missing.** For every commit you read in depth, fill
   `checklists/change-completeness.md` (`working-agreements`, rule 8): what a change of this
   kind should bring with it (tests for its failure paths, an outcome reported back for each
   hand-off, docs, the skills that describe it, a copilot equivalent for a new operator
   capability, a migration). A missing companion is a finding even if the code is right.
6. **Grade** each candidate with `review-judgement`: label, blocking or not, failure scenario,
   refutation attempted. If the same kind of finding has appeared before, add an enforcement
   proposal.
7. **Report**: `$SHARED_DIR/reports/code-review/YYYY-MM-DD-change-review.md`:
   - first line: blocking findings or none; scope (commit range); CI result per commit;
   - depth per commit (read fully / skimmed / skipped, and why);
   - findings `CR-NNN` (sequential across reports; last id in your mental map), each with label,
     blocking flag, criterion, `file:line`, failure scenario, refutation, suggested fix;
   - "For appsec", if any; enforcement proposals, if any;
   - a **hand-off block** for the developers' coding assistant: "Fix CR-004 and CR-007; for each,
     first a test that fails before the fix. ...".
8. **Move your cursor** past what you reviewed; update your mental map (review state, open
   findings, proposed enforcement) and KPIs. PostMessage the user only for a blocking `issue`
   that could lose data, money or availability.

`working-agreements` applies to every report.

## Don't

- Re-report what a tool enforces, unless the tool's allowlist entry has an expired reason.
- Propose large refactors in a change review; one concrete fix per finding. Refactoring
  candidates go to the weekly hotspot report.
- Report preferences as findings, or write a vague all-clear: "no findings" lists what was read.
- File anything publicly; reports stay in the mission's files.
