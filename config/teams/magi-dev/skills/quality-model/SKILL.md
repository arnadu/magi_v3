---
name: quality-model
description: The criteria MAGI's code is graded on, each with its signal, how to measure it, the pass bar or trend, the decision it drives, and what already enforces it. Read before any code review, audit or scorecard.
---

# Quality model

A criterion is graded only if it has all four: a **signal** you can observe, a **measure** you
can run, a **pass bar or trend**, and a **decision** it drives. What can't be measured is a review
question, not a grade. Never write "the code quality is good" without the measures behind it.

## What is already enforced (don't re-check; check that it ran)

These run on every push in CI (`.github/workflows/quality.yml`) and locally before every push
(`npm run verify`). Your job for them is to confirm CI was green for the commits you review
(`ci-status.py`, in `repo-workspace`), and to read their allowlists for entries whose reason no
longer holds.

| Enforcement | Where it is defined | What it covers |
|---|---|---|
| TypeScript strict, `tsc` | `tsconfig.base.json` | Types |
| Biome lint and format, cognitive complexity ≤ 25 | `biome.json` (exemptions listed there) | Consistency, local complexity |
| Tripwires T1–T15 | `scripts/audit/tripwires.sh`, exceptions in `tripwires.allow` | Known dangerous or debt patterns: env in config, HTML sinks, path joins, spawns, git, async handlers, swallowed errors, casts, history comments, raw mailbox writes, collection literals, bare `console.error`, model-id literals |
| Structure ratchet: file ≤ 600 lines, function ≤ 120 | `scripts/audit/structure-check.mjs`, `structure.allow.json` | Size |
| Coverage floors, per package and per risk file | `vitest.config.ts` | Test reach |
| Contract tests on stored documents | `packages/*/tests/*contract*`, `stored-schema.consumers.unit.test.ts` | Writer/reader agreement |
| SAST, secrets, dependency audit | semgrep, gitleaks, `npm run security:deps` | Security hygiene (appsec owns it) |

## Criteria

| # | Criterion | Signal | Measure | Pass bar / trend | Decision it drives | Enforced by |
|---|---|---|---|---|---|---|
| Q1 | **Correctness** | Defects reaching use | Open and recently closed `bug` issues; `fix` commits touching code changed in the previous 14 days (`git log`) | Trend down; every escaped defect gets a regression test | Which modules get a deep review next | Review, tests |
| Q2 | **Failure handling** | Errors swallowed, hung calls, half-done writes | Tripwires T8/T8b/T14 counts; per review: every external call has a timeout and abort, every multi-step write is atomic or compare-and-set | T8/T14 at zero; any new gap is a finding | Block or fix in review | Tripwires + review |
| Q3 | **Readability** | Functions that can't be read in one pass | Biome complexity; function and file length | ≤ 25 complexity, ≤ 120 / 600 lines, exemptions shrinking | Extract before adding more | Biome, structure ratchet |
| Q4 | **Design and dependencies** | Modules mixing concerns; dependencies against the intended direction; cycles | Package import graph (who imports whom); cycles; files changed together across packages (`git log`) | No cycles; no package importing another's internals; trend in cross-package co-change | Where an interface or extraction is needed | Review only (tool in wave 2) |
| Q5 | **Data-model integrity** | One shape per stored collection, used everywhere | T13 count (collection-name literals); local re-declarations of a stored shape outside `packages/agent-config/src/stored/` (`Pick<>` views allowed); dotted paths not built with `field()`/`ref()`; multi-reader collections without a contract test; shape changes without a migration or tolerant reader and a test | All zero | Block a change that adds a parallel shape or changes a stored shape without a migration | T13, contract tests + review |
| Q6 | **Modifiability** | Changes that ripple; copy-paste; dead code | Hotspots (`hotspot-analysis`); duplicated blocks; unused exports | Top hotspots shrinking; no new duplication of house logic | Where refactoring pays | Review (tools in wave 2) |
| Q7 | **Test effectiveness** | Tests that would not fail if the behaviour broke | Per change: is there a test that fails without it? Coverage on risk files; flaky or time-dependent tests; (wave 2: mutation score on one risk module) | Every bug fix has a failing-first test; floors never lowered | Block untested risk changes | Coverage floors + review |
| Q8 | **Type safety** | Escape hatches | T9 count (casts, `any`, `!`), each with a stated reason; external input validated at the boundary | T9 at zero beyond reasoned entries | Block an unexplained cast | `tsc`, T9 |
| Q9 | **Operability** | Failures an operator can't see or diagnose | Every `console.error` names operation, input, consequence; new failure modes in `docs/operational-resilience.md` | Every new background loop, write, schedule or dependency has its failure modes documented | Finding when missing | T14 + review |
| Q10 | **Performance** | Unbounded growth | Per review: unbounded arrays, queries without limits or matching indexes, per-item queries in loops | None new | Finding | Review |
| Q11 | **Rule enforcement** | Written rules nobody checks | `rules-enforcement-audit` matrix: rules with no enforcement and broken in a sample | Every broken unenforced rule has an enforcement proposal | Propose a tripwire, lint rule or test | `rules-enforcement-audit` |
| Q12 | **Delivery** | Red builds, reverts | CI conclusion per commit on main; reverts and fix-of-fix commits | Main green; change failure rate trend down | Investigate the commit that broke it | CI |

Journeys (can each actor complete each operator journey, does every hand-off report back,
does a test play it end to end) and test layers are the qa-lead's lens: flag what you notice
under "For qa-lead" in your report, and leave the review to them.

The repository's own working rules (root `CLAUDE.md` "Working rules", `docs/practices/*.md`) are
the house version of Q2–Q9; quote them in findings.

## Data model, in more detail (Q5)

The stored document's type is the code's type. One canonical type per collection lives in
`packages/agent-config/src/stored/`; collections are reached through `storedCollection()`;
dotted paths through `field<T>()` / `ref<T>()`. Translate shapes only at a real boundary (the
cockpit's API, an external provider), never between two internal modules. Stored data outlives
code: a changed shape needs a migration or a reader that accepts both shapes, with a test that
reads an old-shape document. Data written by a less-trusted party (agents' files, the objectives
store) is validated on read.
