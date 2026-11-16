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

The intended inventory exists: the baseline catalog, `docs/product/operations.md` in the
repository (operations by intent, their actors, rules and home component, and the granularity
rule at its top), with `actors.md`, `entities.md` and `journeys.md` beside it. The product owner
approves it; you do not rewrite it. Your job is the comparison with the code, and what a scan
cannot see.

The scan (`trace-scan`) has done the mechanical part: `$SHARED_DIR/analysis/operations.md`
lists, for each operation, its entry points with their actors, whether each reaches the
operation's home, the database writes each reaches and the HTTP routes it crosses. Start from
it, and from the findings in your "Scan to-do".

What the scan cannot see, and you establish by reading the code:

- **The checks and failure behaviour** each entry point applies: validation, ownership, the
  status it requires, what happens when a resource is missing or a provider refuses. Two entry
  points can reach the same write and still differ here.
- **Whether a difference has a reason** the asker would accept, or is a defect.
- **Whether the catalog is right**: an intent the code serves that no operation describes, an
  actor the catalog lists that should not have it, a rule nobody could implement. These are
  questions for the user, not edits.

Start with operations that change state (create, launch, change, stop, recover, spend); then
the reads that show the operator a figure or a status, where two ways of computing the same
figure can disagree.

## How to work

The inventory is too large for one turn's memory: an agent that tries to hold every entry point
in its context ends up writing names from memory. So:

- **Keep a working file** in your folder (`reports/qa/work/operations-inventory.md`) and add
  to it as you go. Each turn starts by reading it and ends by saving it; your mental map says
  which group of operations is next.
- **One group of operations per turn**, in the order of `operations.md`.
- **Confirm every scan row you use** in the code (`trace-scan`, "How to use a finding"); reach
  can be incomplete where the report lists unresolved calls. For one question, use your clone:
  `npm run trace -- callers <file:line>` or `npm run trace:entry-points`.
- **Name only what you read** (`working-agreements`, rule 9), and run `check-citations.py`
  before a report is done.

## Deliverable

`$SHARED_DIR/reports/qa/YYYY-MM-DD-operations-inventory.md`:

1. **The comparison**, one row per catalog operation (its id, e.g. `mission.launch`): for each
   entry point, the checks and failure behaviour it applies and the function that applies them
   (file and name). Mark each operation **one implementation** or **several**.
2. **Findings**, for every operation with several implementations, every operation an expected
   actor cannot reach, and every catalog question: what differs, the evidence, what
   an operator or agent would experience, and the fix (usually: one implementation, the entry
   points reduced to who may ask and how the result is shown).
3. **Coverage**: which actors and areas you inventoried fully, which partly, and what you did
   not reach. An inventory that does not say what it left out cannot be trusted as complete.

Verify it with the checklist `checklists/inventory-checks.md` (`checklist.py`, as in
`working-agreements`). Hand-off block for the developers' coding assistant.

## What you never do

Change the repository; treat a document's description of a path as evidence of what the code
does; call two entry points equivalent without naming the code each one runs.
