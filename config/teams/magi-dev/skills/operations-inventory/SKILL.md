---
name: operations-inventory
description: Build MAGI's inventory of operations top down — what the system does for each actor, defined by intent — and establish, from the code, whether every actor who can ask for an operation gets the same one. The use-case model (actors × operations) of the platform.
---

# Operations inventory

## What you are establishing

An **operation** is something the system does for whoever asks it: a person in the cockpit,
the control copilot, the mission copilot, an agent, a background job, or the platform itself
on a timer. It is defined by its **intent** — what the asker wants to happen — not by the code
path or the mechanism. Two requests with the same intent are one operation, even if they reach
different code; two operations that happen to share a mechanism are still two.

The aim, for each operation:

- **Who can ask for it, and how** — each actor's entry point (cockpit screen and route, copilot
  action or tool, agent tool, job tool, scheduled task).
- **What its rules are** — the checks it makes, the effects it has, what it does when something
  has gone wrong (a resource missing, a provider refusing, a concurrent request).
- **Whether every actor gets the same operation** — the same checks, the same effects, the same
  behaviour on failure. Being able to ask is not enough. Show it by naming the function each
  entry point reaches; when they differ, say what differs and whether there is a reason for it
  that the asker would accept.

Well-known names for this: a use-case model (actors × use cases), the application layer of
hexagonal or clean architecture, a command with one handler. The principle behind it: every
rule of the system has one authoritative home, whoever triggers it.

## Where to start

Top down, from what actors are meant to be able to do, not from a listing of the code:
the journeys (`qa-journeys/checklists/journeys.md`), the cockpit's screens and buttons, what
the copilots' prompts and skills tell them they can do, the agents' tool catalogue, the
platform's scheduled work, the user guide and the spec. Then go to the code for each entry
point to find what it actually runs. An entry point you meet in the code that matches no
operation on your list is itself a finding: either the list missed an intent, or the code
offers something no actor is meant to have.

Start with operations that change state (create, launch, change, stop, recover, spend); then
the reads that show the operator a figure or a status, where two ways of computing the same
figure can disagree.

## How to work

The inventory is too large for one turn's memory: an agent that tries to hold every entry point
in its context ends up writing names from memory. So:

- **Keep a working file** in your folder (`reports/qa/work/operations-inventory.md`) and add
  to it as you go. Each turn starts by reading it and ends by saving it; your mental map says
  which actor or area is next.
- **One actor or area per turn** — the cockpit's operations, the control copilot's, the
  mission copilot's, the agents', background jobs, the platform's scheduled work, then the
  figures shown in several places.
- **Reconcile with the code's own list** once your top-down list for an actor exists:
  `python3 $SHARED_DIR/skills/_team/operations-inventory/scripts/entry-points.py <clone>`
  lists every route, action, tool and scheduled task with file:line. An entry point there that
  your list does not explain, and an operation of yours with no entry point there, are both
  findings to resolve. It says what exists, not what each entry point does: read the code for
  that.
- **Name only what you read** (`working-agreements`, rule 9), and run `check-citations.py`
  before a report is done.

## Deliverable

`$SHARED_DIR/reports/qa/YYYY-MM-DD-operations-inventory.md`:

1. **The inventory**, one row per operation: id (O-NN), intent in one sentence, its rules
   (checks, effects, failure behaviour), and for each actor the entry point and the function it
   reaches (file and name). Mark each operation **one implementation** or **several**.
2. **Findings**, for every operation with several implementations, every operation an expected
   actor cannot reach, and every entry point with no operation: what differs, the evidence, what
   an operator or agent would experience, and the fix (usually: one implementation, the entry
   points reduced to who may ask and how the result is shown).
3. **Coverage**: which actors and areas you inventoried fully, which partly, and what you did
   not reach. An inventory that does not say what it left out cannot be trusted as complete.

Verify it with the checklist `checklists/inventory-checks.md` (`checklist.py`, as in
`working-agreements`). Hand-off block for the developers' coding assistant.

## What you never do

Change the repository; treat a document's description of a path as evidence of what the code
does; call two entry points equivalent without naming the code each one runs.
