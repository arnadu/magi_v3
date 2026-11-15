# MAGI product baseline

**Status: draft since 2026-11-14,** awaiting the product owner's review.

This folder says what MAGI is meant to do: who uses it, what they work with, what they can ask
for, and the journeys they take. It is the **intended** model. The code is the **as-built**
model, read by scans. Reviews compare the two. The design behind this split is in
[magi-dev-requirements.md](../plans/magi-dev-requirements.md), "The application model"; the
approach (why, which practices, which tools, how agents and code comply) is
[ADR-0036](../adr/0036-product-and-architecture-baselines.md).

## Where it lives

The source is a typed catalog in
[`packages/agent-config/src/baseline/`](../../packages/agent-config/src/baseline/). The tables in
this folder and in [`docs/architecture/components.md`](../architecture/components.md) are
generated from it by `npm run docs:baseline`, and a test fails when they are stale. **Edit the
catalog, not the tables.** This README is the only hand-written page.

| Document | Defines | Ids |
|---|---|---|
| [actors.md](actors.md) | Who can ask MAGI for something, and how they reach it | `OP`, `CC`, `MC`, … |
| [entities.md](entities.md) | What they work with; where each is stored, its states, allowed transitions and invariants | `mission`, `schedule`, …; invariants `mission.capped`, … |
| [operations.md](operations.md) | What each actor can ask for, the rules that hold whoever asks, and the component meant to hold its one implementation | `mission.launch`, … |
| [journeys.md](journeys.md) | The operator journeys, as sequences of operations | `J-01`, … |
| [../architecture/components.md](../architecture/components.md) | The components and the source paths each owns; dependency rules | `cp-api`, `mm-state`, … |

## How it is used

- **The code** names baseline ids: an entry point declares the operation it serves (an
  `OperationId`, checked by the compiler); a test that walks a journey or enforces an invariant
  names its id.
- **Scans** join their results to the catalog by these ids: every file to its component, every
  entry point to its operation and the home it reaches, every status write to an entity's
  transitions. They report where code and baseline disagree.
- **Reviewer agents** read these documents for intent and the scans for facts, and judge each
  disagreement: a finding against the code, or a question for the product owner.
- **The product owner** approves every change to the catalog.

## Rules for this baseline

- **Written from intent, not from the code.** Where the code does something else, that is a
  finding against the code, or a question for the product owner. It is never a quiet edit here.
- **Ids are stable.** A retired id is never reused.
- **The product owner approves changes.** Anyone may propose one: a reviewer agent through a
  finding, the coding assistant through a commit. A decision between alternatives is recorded
  in an ADR that names the ids it changes.
- **Reviews name the commit** of the catalog they checked against.
- **One home per fact.** The SPEC describes mechanisms and cites these ids rather than restating
  states or rules.

## Open questions

- **Homes marked "undecided"** in [operations.md](operations.md): `mission.change-config`,
  `mission.archive`, `schedule.create`, `schedule.cancel`, `agent.pause`, `agent.resume`,
  `file.write`, `mission.status`, `mission.results`. Each is a choice of component for the
  architect.
- **Transitions of objectives and tasks** are not yet specified.
