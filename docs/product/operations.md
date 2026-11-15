<!-- Generated from packages/agent-config/src/baseline/ by `npm run docs:baseline`. Edit the catalog, not this file. -->

# Operations

**Draft since 2026-11-14, awaiting the product owner's approval.** What actors can ask MAGI to do. An operation is defined by its intent; its rules hold whoever asks. Each operation has **one** implementation in the code (its home), in the component named here, and every entry point that serves it calls that home, adding only who may ask and how the result is shown ([code-structure practice](../practices/code-structure.md), "One operation, one home"). Entry points declare the operation id they serve; a test fails on an entry point without an id. "undecided" is an open question for the architect. Actors: [actors.md](actors.md); "CC" means a proposal the operator confirms.

## Missions

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `mission.create-draft` | Start a mission as an editable draft | OP, CC | `cp-mission-ops` | Valid id, owned by the requester; Nothing runs |
| `mission.edit-draft` | Change a draft before launch | OP, CC | `cp-mission-ops` | Validated as a launch would validate it; A write based on an outdated version is refused |
| `mission.launch` | Start a draft running | OP, CC | `cp-mission-ops` | Only a draft; Only once, even if asked twice at the same moment; Capped before any machine starts; A failure leaves the mission in `error` with its reason, and no orphaned resources |
| `mission.create` | Create from a template and launch at once | OP, CC | `cp-mission-ops` | The same checks as `mission.create-draft` followed by `mission.launch` |
| `mission.suspend` | Stop a mission's machine, keeping its work | OP, CC | `cp-mission-ops` | Only a running mission |
| `mission.resume` | Bring a suspended or failed mission back | OP, CC | `cp-mission-ops` | Works whatever happened to the old machine; on the default machine and the existing volume; For a mission in `error`, CC diagnoses first, then may run this restore on its own, within a recovery budget the platform counts per mission; A failed attempt is never repeated without a new diagnosis; CC hands over to the operator, with its analysis and a plan, when the budget is spent, when it is unsure of the cause, or when the fix would change cost or size, delete anything or touch data |
| `mission.reconcile` | Keep the stored status in step with the machine's actual state | PLT | `cp-mission-ops` | On a timer, one home; An unplanned stop becomes `error` with its reason, and the operator is told; Never during a resize or another claimed transition; Reading a mission never changes it |
| `mission.wake` | Start a stopped machine so due work is delivered | PLT | `cp-machines` | Wakes a suspended mission too; it stays running; The operator is told what woke it |
| `mission.change-config` | Change a mission's agents, prompts, models, settings or files | OP, CC, MC | undecided | Applied while the mission runs; suspension is a last resort, only for a change that needs all activity stopped (a change of machine size or of the agents roster); Validated as a launch; A write based on an outdated version is refused; The operator is told what changed |
| `mission.set-spend-cap` | Set the most a mission may spend | OP, CC, MC | `cp-mission-ops` | Never above the ceiling; Takes effect without a restart; A cap above current spend lifts a budget pause; The operator is told |
| `mission.set-ceiling` | Set the most anyone may set the cap to | OP, ADM | `cp-mission-ops` | OP up to the platform maximum; ADM above it; Not reachable by any copilot or agent |
| `mission.archive` (planned) | End a mission: stop all its costs, keep its results readable | OP | undecided | Until it is built, a mission ends suspended; Missions are not deleted (decision D-6, 2026-09-12) |

## Work inside a mission

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `message.send` | Give an agent work or information | OP, MC, AG | `mm-state` | Recipients on the roster; Wakes the recipient |
| `schedule.create` | Have a message or job delivered later or repeatedly | OP, CC, MC, AG | undecided | OP in the cockpit or through CC; The schedule invariants hold (see the schedule entity) |
| `schedule.cancel` | Stop a schedule | OP, CC, MC, AG | undecided | AG: its own schedules only; A cancelled file-backed schedule stays cancelled until its file is removed |
| `agent.pause` | Stop one agent's dispatch | OP, CC, MC | undecided | Takes effect before the agent's next turn; Holds across restarts until someone resumes the agent; Agents never pause a teammate |
| `agent.resume` | Restart one agent's dispatch | OP, CC, MC | undecided | Takes effect before the agent's next turn |
| `objectives.edit` | Change the objective tree | CC, MC | `mm-state` | No duplicate ids, unknown parents or cycles |
| `task.update` | Record progress on a task | AG, MC | `mm-state` | Assignee, creator, objective owner or MC only |
| `file.write` | Put a file in the mission's shared folder | OP, CC, AG | undecided | Contained in the shared folder; No symlink escapes |
| `job.submit` | Run a script in the background | AG | `mm-jobs` | Runs as its author, with no secrets |
| `machine.upgrade` | Run on a bigger machine for a while | AG, MC | `cp-machines` | AG asks through MC; Within the duration and daily caps; Reverted on time; The operator is told |
| `issue.file` | Report a bug or idea about MAGI | CC, MC | `cp-copilot` | Becomes a proposal the operator confirms |
| `image.create` | Make images for the mission's work | AG | `mm-tools` | Within the per-call budget; Spend counts against the mission |

## Reads that must agree wherever they are shown

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `mission.status` | State, machine, reason for an error | OP, CC, MC | undecided | The same figure wherever it is shown; Reading never changes it |
| `mission.spend` | Spend against cap and ceiling | OP, CC, MC | `cp-mission-ops` | The same figure wherever it is shown: the header, Limits, Objectives, both copilots |
| `mission.results` | Files, messages, objectives' progress | OP, CC, MC | undecided | The same figure wherever it is shown |

## Copilot and account

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `copilot.confirm` | Accept a copilot's proposal | OP | `cp-copilot` | Carried out once, even if confirmed twice; The proposer is told the outcome |
| `copilot.dismiss` | Refuse a copilot's proposal | OP | `cp-copilot` | The proposer is told |
| `copilot.settings` | Configure one's own copilot | OP | `cp-copilot` |  |
| `copilot.limits` | Set one's own copilot's limits | OP | `cp-copilot` |  |
| `session.sign-in` | Start using the cockpit | OP | `cp-edge` |  |
| `session.sign-out` | Stop using the cockpit | OP | `cp-edge` |  |
