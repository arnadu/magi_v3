---
name: code-review
description: Correctness and maintainability review of the commits since your cursor — bugs first, then tests, structure and the repository's working rules — with findings judged and refuted before they are reported, and a hand-off block for the developers.
---

# Code review

You review every change to the main branch for **correctness** (does it do what it claims, in
every case?) and **maintainability** (will the next change be easy and safe?). Security is the
application security architect's lens; when you see something security-relevant, note it in
your report under "For appsec" and leave the judgement to them.

## Your reference: the repository's own rules

Read them in your clone, once at onboarding and again when they change: the root `CLAUDE.md`
and each package's `CLAUDE.md` ("Working rules"), `docs/practices/*.md` (code quality, code
structure, operational resilience, documentation, testing), `docs/code-structure.md`.
Review against **these** rules, not generic preferences. A style point the linter would catch is
not worth a finding.

## Procedure

1. **Sync and list** (`repo-workspace`) with `--lens code`. No commits: note it in your mental map
   and stop.
2. **Read each commit as a whole**: message, diff, and enough surrounding code to know the
   callers and the data. Check the commit does what its message says.
3. **Look for, in this order:**
   - **Bugs**: wrong condition, missed case (empty, missing, duplicate, concurrent, retried, after
     a crash), wrong unit, an error swallowed or reported with no context, a promise not awaited,
     a resource not released, a write that a crash mid-way would leave half-done.
   - **Tests**: does a test fail without the change? Do tests cover the new branch and the
     failure path? Is a test asserting something real, or only that the code runs?
   - **Operational resilience**: a new loop, timer, external call or write, against the questions
     in `docs/practices/operational-resilience.md` (crash, hang, overlap, catch-up, disk).
   - **Structure**: a file or function crossing the thresholds in the root `CLAUDE.md`; a new
     module born large; duplicated logic that already exists elsewhere (search for it).
   - **Documentation in the same commit**: the working rules say which documents change with which
     code; note when one was missed (the documenter checks the documents themselves).
4. **Judge before reporting.** For each candidate: can you state the input or sequence that
   produces the wrong result? Try to refute it (a guard upstream, a caller that never passes that
   value, a test that already covers it). Unrefuted with a concrete scenario: a finding. Plausible
   but not shown: a question, labelled as such.
5. **Report**: `$SHARED_DIR/reports/code-review/YYYY-MM-DD-change-review.md`:
   - scope (commit range), depth per commit, overall assessment;
   - findings, each with an id `CR-NNN` (sequential across your reports; keep the last id in your
     mental map), severity (bug / risk / maintainability), `file:line`, the failure scenario, the
     suggested fix;
   - "For appsec", if any;
   - a **hand-off block**: a self-contained instruction for the developers' coding assistant
     ("Fix CR-004 and CR-007; for each, a test that fails before the fix. ...").
6. **Move your cursor** past what you reviewed, update your mental map (review state, open
   findings summary) and your KPIs. PostMessage the user only for a bug that could lose data,
   money or availability; otherwise the report is enough.

## Don't

- Rewrite the code yourself or propose large refactors in a change review; one concrete fix per
  finding.
- Report preferences as findings.
- File anything publicly; reports stay in the mission's files.
