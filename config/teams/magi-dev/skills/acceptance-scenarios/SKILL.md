---
name: acceptance-scenarios
description: Write acceptance scenarios for operator journeys in the format of the planned scenario test harness — the operator's request, scripted replies, which cards to confirm, state assertions and friction budgets — so a journey without a test gets one specified.
---

# Acceptance scenarios

The scenario harness is planned in `docs/plans/scenario-test-harness.md` (read it in your
clone): a test plays an operator story against the real copilots and checks the resulting
state, never the wording. Until it is built, you write the scenarios it will run; afterwards,
you keep them current. Write one for every journey without an end-to-end test, and for every
bug the operator found in live use.

## Where

`$SHARED_DIR/reports/qa/scenarios/<id>.md`, one per scenario, id `S-NN` (control copilot),
`M-NN` (mission copilot) or `O-NN` (cockpit-only), continuing the plan's numbering. Keep an
index in `$SHARED_DIR/reports/qa/scenarios/index.md`: id, journey, status (proposed, accepted
by the user, automated).

## Format

```markdown
# S-10 — <short title>          Journey: J-NN

**Setup:** the state before the story (existing missions, seeded mail or anomalies, model).
**Request:** the operator's exact message.
**Scripted replies:** keyword → reply, for the questions the copilot is expected to ask.
**Card policy:** confirm all | confirm types X, dismiss Y | ...
**Passes when** (state, checked by the harness):
- <a fact in the database, a file, a card and its order, a message and its recipient>
- ...
**Budgets:** cards ≤ n · operator replies ≤ n · minutes ≤ n · cost ≤ $n
**Why:** the journey or the bug this protects (link the report or issue).
```

## Rules

- Assert **state**, never wording: "a draft with two agents exists", not "the copilot said it
  created a draft".
- Every assertion must be checkable by a program from the database, the files or the list of
  cards and messages.
- Budgets come from the journey review's friction count: the minimum the safety rules allow,
  plus a margin you state.
- A scenario for a live bug reproduces the operator's actual request as closely as possible.
