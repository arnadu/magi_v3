# MAGI product baseline

**Status: draft, 2026-11-14.** The product owner's decisions on the first open questions are
at the end of this page; the baseline as a whole awaits their review.

This folder says what MAGI is meant to do: who uses it, what they work with, what they can ask
for, and the journeys they take. It is the **intended** model. The code is the **as-built**
model, read by scans. Reviews compare the two. The design behind this split is in
[magi-dev-requirements.md](../plans/magi-dev-requirements.md), "The application model".

| File | Defines | Ids |
|---|---|---|
| [actors.md](actors.md) | Who can ask MAGI for something, and how they reach it | `OP`, `CC`, `MC`, … |
| [entities.md](entities.md) | What they work with: missions, schedules, jobs…; each one's states and allowed transitions | `mission`, `schedule`, … |
| [operations.md](operations.md) | What each actor can ask for, and the rules that hold whoever asks | `mission.launch`, … |
| [journeys.md](journeys.md) | The operator journeys, as sequences of operations | `J-01`, … |

The components the software is built from are in the architecture baseline,
[../architecture/components.md](../architecture/components.md).

## Rules for this baseline

- **Written from intent, not from the code.** Where the code does something else, that is a
  finding against the code, or a question for the product owner. It is never a quiet edit here.
- **Ids are stable.** They appear in the code's operations registry, in tests and scenarios, and
  in reviewers' reports. A retired id is never reused.
- **The product owner approves changes.** Anyone may propose one: a reviewer agent through a
  finding, the coding assistant through a commit. A change merges when the product owner has
  approved it; the governance engine's requirements gate will enforce this later.
- **Reviews name the commit** of this folder they checked against.

## Decisions

Answered by the product owner on 2026-11-14:

| Id | Question | Decision |
|---|---|---|
| Q-01 | A schedule falls due while its mission is suspended | Wake the machine; it stays running, and the operator is told what woke it |
| Q-02 | A mission in `error` | The control copilot recovers it on its own, within a budget the platform enforces, and decides when it needs human help: when the budget is spent, when it is unsure of the cause, or when the fix goes beyond restoring a known-good state. No doom loop: a failed attempt is never repeated without a new diagnosis |
| Q-03 | Creating schedules | Both: the intended way is through the copilot, and the operator can also define a schedule by hand in the cockpit |
| Q-04 | Changing a mission's configuration | Changes that can be applied while agents run are applied without suspending; suspending is a last resort for changes that need all activity stopped |
| Q-05 | How a mission ends | Suspend is the end state until archive exists; archive stops all costs and keeps the results readable; missions are not deleted (decision D-6) |
| Q-06 | Who may pause an agent | The operator and the copilots only; a supervisor agent works with the agents it oversees through the mailbox |
| Q-07 | A paused agent across a restart | It stays paused |
| Q-08 | Which configuration changes need all activity stopped | A change of machine size or of the agents roster |
