---
name: qa-journeys
description: Review MAGI top down, from the operator's journeys — for each journey, walk every step through the code for each actor (operator in the cockpit, control copilot, mission copilot), and find what is missing, slow, silent or untested. Also test-layer coverage and where bugs are found.
---

# Journey review

Reviewers who read code module by module miss what is **missing between modules**: a step one
actor can't reach, a hand-off whose result nobody hears about, a workflow the instructions send
down the slow path, a journey no test plays. In November 2026 the operator found all four in
one afternoon of creating a mission. This skill exists to find them first.

Checklists, in this skill's `checklists/` folder (`$SHARED_DIR/skills/_team/qa-journeys/checklists/`):
- `journeys.md` — the operator journeys and their actors (a reference list; add journeys you
  discover);
- `journey-checks.md` — the questions to answer for one journey;
- `test-layers.md` — what kinds of tests exist and run.

Work through them with `checklist.py` (`working-agreements`).

## Reviewing one journey

1. **Pick the journey** from your rotation (mental map), or the one a report or the operator
   points at. Start a checklist:
   `python3 $SHARED_DIR/skills/_team/working-agreements/scripts/checklist.py start $SHARED_DIR/skills/_team/qa-journeys/checklists/journey-checks.md --out $SHARED_DIR/reports/qa/checklists/YYYY-MM-DD-J-NN.md`
   and write the journey's id and name at the top.
2. **Walk it from the code, not the documents.** For each actor that can do this journey,
   write the steps in order: the cockpit screen or button (`packages/cockpit/src/`), the
   route it calls (`packages/control-plane/src/`), the copilot tool or ProposeAction type
   (`copilot-*-tools.ts`, `copilot-actions.ts`, the mission copilot's `mission-copilot-*-tools.ts`),
   what the skills and prompts tell the copilot to do (`config/teams/copilot/`,
   `packages/skills/`, `packages/agent-runtime-worker/prompts/`), and what happens next
   (who is told, what state changes). Put the walk in the report as a numbered list.
3. **Answer every row of `journey-checks.md`** with evidence. A step one actor cannot do, a
   hand-off nobody hears about, an extra confirmation, a missing test: each is a finding.
4. **Compare actors.** What can the operator do in the cockpit that the copilot cannot, and
   the reverse? A gap matters when that actor is expected to do the journey (a copilot is
   expected to set up a mission on request).
5. **Report** in `$SHARED_DIR/reports/qa/YYYY-MM-DD-journey-J-NN.md`: the walk, the checklist
   summary, findings (each with the step, the evidence, the effect on the operator, the
   suggested fix), and an acceptance scenario for the journey if it has no test
   (`acceptance-scenarios`). Hand-off block for the developers' coding assistant.

## Test layers (monthly)

Fill `test-layers.md` from the repository: the test folders (`packages/*/tests/`, naming
`*.unit.test.ts` and `*.integration.test.ts`), `vitest*.config.ts`, and which suites
`.github/workflows/quality.yml` actually runs. Count tests per layer with `grep -c`.

## Where bugs are found (monthly)

For the bug fixes of the last 30 days (`git log --since="30 days ago" --grep -i fix --oneline`,
and closed issues labelled `bug`:
`https://api.github.com/repos/<owner>/<repo>/issues?state=closed&labels=bug&since=<date>` with
FetchUrl), record how each was found: a failing test, a reviewer's report (a MAGI DEV report
counts), an audit, or the operator in live use. Read the issue text and the commit message.
**Every bug found in live use is a missing test**: propose its acceptance scenario.

## What you never do

Change code or the repository; run anything against production; judge security (pass it to
appsec) or code style (the code reviewer's). Your lens is the operator's experience and
whether the product does what its journeys need, end to end.
