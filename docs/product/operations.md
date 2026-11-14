# Operations

**Draft, 2026-11-14.** What actors can ask MAGI to do. An operation is defined by its intent;
its rules hold whoever asks. Each operation has **one** implementation in the code (its home),
and every entry point that serves it calls that home, adding only who may ask and how the
result is shown ([code-structure practice](../practices/code-structure.md), "One operation, one
home").

The id is the join with the code: the operations registry declares, for each entry point, the
id it serves. A test fails when an entry point declares no id, or an id that is not here.

Actors: see [actors.md](actors.md). "CC" means a proposal the operator confirms.

## Missions

| Id | Intent | Actors | Rules that hold for every actor |
|---|---|---|---|
| `mission.create-draft` | Start a mission as an editable draft | OP, CC | Valid id, owned by the requester; nothing runs |
| `mission.edit-draft` | Change a draft before launch | OP, CC | Validated as a launch would validate it; a write based on an outdated version is refused |
| `mission.launch` | Start a draft running | OP, CC | Only a draft; only once, even if asked twice at the same moment; capped before any machine starts; a failure leaves the mission in `error` with its reason, and no orphaned resources |
| `mission.create` | Create from a template and launch at once | OP, CC | The same checks as `mission.create-draft` followed by `mission.launch` |
| `mission.suspend` | Stop a mission's machine, keeping its work | OP, CC | Only a running mission |
| `mission.resume` | Bring a suspended or failed mission back | OP, CC | Works whatever happened to the old machine; on the default machine and the existing volume. For a mission in `error`, CC diagnoses first, then may run this restore on its own, within a recovery budget the platform counts per mission; a failed attempt is never repeated without a new diagnosis. CC hands over to the operator, with its analysis and a plan, when the budget is spent, when it is unsure of the cause, or when the fix would change cost or size, delete anything or touch data |
| `mission.wake` | Start a stopped machine so due work is delivered | PLT | Wakes a suspended mission too; it stays running; the operator is told what woke it |
| `mission.change-config` | Change a mission's agents, prompts, models, settings or files | OP, CC, MC | Applied while the mission runs; suspension is a last resort, only for a change that needs all activity stopped (a change of machine size or of the agents roster); validated as a launch; a write based on an outdated version is refused; the operator is told what changed |
| `mission.set-spend-cap` | Set the most a mission may spend | OP, CC, MC | Never above the ceiling; takes effect without a restart; a cap above current spend lifts a budget pause; the operator is told |
| `mission.set-ceiling` | Set the most anyone may set the cap to | OP (up to the platform maximum), ADM | Not reachable by any copilot or agent |
| `mission.archive` | End a mission: stop all its costs, keep its results readable | OP (planned) | Not built yet; until then a mission ends suspended. Missions are not deleted (decision D-6, 2026-09-12) |

## Work inside a mission

| Id | Intent | Actors | Rules |
|---|---|---|---|
| `message.send` | Give an agent work or information | OP, MC, AG | Recipients on the roster; wakes the recipient |
| `schedule.create` | Have a message or job delivered later or repeatedly | OP (cockpit), CC, MC, AG | See the schedule invariants in [entities.md](entities.md) |
| `schedule.cancel` | Stop a schedule | OP, CC, MC, AG (own) | A cancelled file-backed schedule stays cancelled until its file is removed |
| `agent.pause`, `agent.resume` | Stop or restart one agent's dispatch | OP, CC, MC | Takes effect before the agent's next turn; a pause holds across restarts until someone resumes the agent; agents never pause a teammate |
| `objectives.edit` | Change the objective tree | CC, MC | No duplicate ids, unknown parents or cycles |
| `task.update` | Record progress on a task | AG, MC | Assignee, creator, objective owner or MC only |
| `file.write` | Put a file in the mission's shared folder | OP, CC, AG | Contained in the shared folder; no symlink escapes |
| `job.submit` | Run a script in the background | AG | Runs as its author, with no secrets |
| `machine.upgrade` | Run on a bigger machine for a while | AG (through MC), MC | Within the duration and daily caps; reverted on time; the operator is told |
| `issue.file` | Report a bug or idea about MAGI | CC, MC | Becomes a proposal the operator confirms |
| `image.create` | Make images for the mission's work | AG | Within the per-call budget; spend counts against the mission |

## Reads that must agree wherever they are shown

| Id | Figure | Shown to |
|---|---|---|
| `mission.status` | State, machine, reason for an error | OP, CC, MC |
| `mission.spend` | Spend against cap and ceiling | OP (header, Limits, Objectives), CC, MC |
| `mission.results` | Files, messages, objectives' progress | OP, CC, MC |

## Copilot and account

| Id | Intent | Actors |
|---|---|---|
| `copilot.confirm`, `copilot.dismiss` | Decide on a copilot's proposal | OP |
| `copilot.settings`, `copilot.limits` | Configure one's own copilot | OP |
| `session.sign-in`, `session.sign-out` | Use the cockpit | OP |
