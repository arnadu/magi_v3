# MAGI product baseline

**Status: approved 2026-11-19** by the product owner, after two rounds of review
([catalog-review.md](../plans/catalog-review.md): the definitions the catalog is kept by, and each
decision).

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
| [entities.md](entities.md) | What they work with; where each is stored, its states, allowed transitions and invariants; the platform-wide and security invariants | `mission`, `turn`, …; invariants `mission.capped`, `platform.no-memory-only-state`, `sec.authenticated`, … |
| [operations.md](operations.md) | What each actor can ask for, the rules that hold whoever asks, and the component meant to hold its one implementation; the entry classes for entry points that serve no operation | `mission.launch`, …; `infrastructure`, … |
| [journeys.md](journeys.md) | The operator's journeys (with the copilots) and the agents' own, as sequences of operations | `J-01`, …; `A-01`, … |
| [../architecture/components.md](../architecture/components.md) | The components and the source paths each owns; the data stores and the one component that writes each; the external systems; dependency rules | `cp-api`, `mm-state`, `ui-files`, … |

## How it is used

- **The code** names baseline ids: an entry point declares the operation it serves (an
  `OperationId`, checked by the compiler); a test that walks a journey or enforces an invariant
  names its id.
- **Scans** join their results to the catalog by these ids: every file to its component, every
  entry point to its operation and the home it reaches, every status write to an entity's
  transitions. They report where code and baseline disagree.
- **Reviewer agents** read these documents for intent and the scans for facts, and judge each
  disagreement: a finding against the code, or a question for the product owner.
- **Invariants** say what must always be true. Each lists what enforces it (a test titled with
  its id, a scan, a runtime check, or review) and, when adopting it was a choice between
  alternatives, the ADR that made it. The trace reports the ones nothing enforces yet.
- **ADRs** add the design rules the code must keep. Their front matter names the baseline ids
  each governs and how each rule is enforced (ADR-0036, decision 10).
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

- **Open decisions on invariants**, to be settled in one ADR on the durable record and crash
  recovery: how long the full input and output of model calls are kept, and where
  (`llm-call.recorded`); whether an interrupted turn is resumed or closed
  (`turn.no-silent-loss`).
- **Decision D-6** (missions are not deleted), behind `mission.work-kept`, has no ADR.
- **Where the code falls short of the catalog:** the roadmap's "Backlog: catalog gaps".
- **The threat model and the trust-boundaries table** still state their guards in their own
  words; they will cite the security invariants by id.
- **Transitions of objectives and tasks** are not yet specified.
