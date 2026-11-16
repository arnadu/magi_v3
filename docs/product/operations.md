<!-- Generated from packages/agent-config/src/baseline/ by `npm run docs:baseline`. Edit the catalog, not this file. -->

# Operations

**Draft since 2026-11-14, awaiting the product owner's approval.** What actors can ask MAGI to do. An operation is defined by its intent; its rules hold whoever asks. **One operation per intent whose rules differ** (who may ask, what is checked, what it costs, what it changes): requests with the same rules are one operation whatever their entry point, and different rules make different operations even on the same data. Each operation has **one** implementation in the code (its home), in the component named here, and every entry point that serves it calls that home, adding only who may ask and how the result is shown ([code-structure practice](../practices/code-structure.md), "One operation, one home"). Every entry point declares the operation id it serves, or an entry class (end of this page). "(read)" marks a figure shown to its actors. Actors: [actors.md](actors.md); "CC" means a proposal the operator confirms.

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
| `mission.change-config` | Change a mission's agents, prompts, models, settings, files or limits | OP, CC, MC | `cp-mission-ops` | Applied while the mission runs; suspension is a last resort, only for a change that needs all activity stopped (a change of machine size or of the agents roster); Validated as a launch; A write based on an outdated version is refused; The operator is told what changed |
| `mission.repair` | Correct the mission's record of its machine and volume from the provider's actual state | CC | `cp-machines` | Ids are taken from the provider, never from the request; Never creates or deletes a machine or a volume; A proposal the operator confirms |
| `mission.archive` (planned) | End a mission: stop all its costs, keep its results readable | OP | `cp-mission-ops` | Until it is built, a mission ends suspended; Missions are not deleted (decision D-6, 2026-09-12) |
| `mission.status` (read) | A mission's state, machine and roster, and the reason for an error | OP, CC, MC, AG | `cp-mission-ops` | The same figure wherever it is shown; reading never changes it; AG: its own mission's roster only |
| `mission.config` (read) | A mission's stored configuration | OP, CC, MC | `cp-api` | The same figure wherever it is shown; reading never changes it; No secret values |
| `mission.log` (read) | The daemon's log, for diagnosis | OP, CC, MC | `mm-monitor` | The same figure wherever it is shown; reading never changes it; No secret values; Bounded in size |

## Spend and machine

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `mission.set-spend-cap` | Set the most a mission may spend | OP, CC, MC | `cp-mission-ops` | Never above the ceiling; Takes effect without a restart; A cap above current spend lifts a budget pause; The operator is told |
| `mission.set-ceiling` | Set the most anyone may set the cap to | OP, ADM | `cp-mission-ops` | OP up to the platform maximum; ADM above it; Not reachable by any copilot or agent |
| `mission.spend` (read) | Spend against cap and ceiling: in total, per agent, over time, and runtime by machine shape | OP, CC, MC | `cp-mission-ops` | The same figure wherever it is shown; reading never changes it; Shown in the header, Limits, Objectives and both copilots, always the same figure |
| `account.usage` (read) | Spend across all of one's missions | OP, ADM | `cp-oversight` | The same figure wherever it is shown; reading never changes it; OP: their own missions; ADM: all |
| `machine.upgrade` | Run on a bigger machine for a while, then go back | AG, MC, PLT | `cp-machines` | AG asks through MC; Within the duration and daily caps; PLT reverts it on time; The operator is told |
| `machine.reset-upgrade-allowance` | Reset the cumulative upgrade cap | OP | `cp-machines` | Not reachable by any copilot or agent |

## Agents and the agent loop

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `agent.dispatch` | Decide which agent runs next, and start its turn | PLT | `mm-daemon` | Only an agent with unread mail; Never a paused agent, nor one cooling down after a model error; Nothing while the mission's spend has reached its cap; One turn per agent at a time; New mail during a turn is picked up after it |
| `agent.turn` | Run one turn: build the prompt, call the model, run the tools, record cost, report to the supervisor | PLT | `mm-agent-loop` | The prompt holds the agent's role, its mental map and the regions the platform manages; Every turn ends, within the agent's limits and a wall-clock timeout; Spend counts against the mission; Tool arguments are checked against the tool's schema |
| `agent.reflect` | Compact an agent's memory when its context grows too large or its turns stop producing output | PLT | `mm-agent-loop` | Keeps the mental map and the conversation's history readable; Spend counts against the mission |
| `agent.remember` | Edit one's own mental map | AG | `mm-agent-loop` | Sections with an id only; Regions the platform manages are not editable by the agent |
| `agent.shell` | Run a command in one's own workspace | AG | `mm-tools` | As the agent's own OS user, with no secrets in its environment; Bounded in time and output |
| `web.read` | Search, fetch, browse and research the web; inspect images | AG, JOB | `mm-tools` | Never reaches an internal address, at any redirect; Bounded in size and time; Spend counts against the mission |
| `data.query` | Query a data provider | JOB | `mm-tools` | The provider's key never reaches the caller |
| `agent.pause` | Stop one agent's dispatch | OP, CC, MC | `mm-daemon` | Takes effect before the agent's next turn; Holds across restarts until someone resumes the agent; Agents never pause a teammate |
| `agent.resume` | Restart one agent's dispatch | OP, CC, MC | `mm-daemon` | Takes effect before the agent's next turn |
| `agent.history` (read) | What an agent did and why: its turns, transcripts, model calls, mental map and memories | OP, CC, MC, AG | `cp-records` | The same figure wherever it is shown; reading never changes it; AG: its own memories only |

## Messages

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `message.send` | Give an agent work or information | OP, MC, AG, JOB | `mm-state` | Recipients on the roster; Wakes the recipient |
| `message.read` (read) | Read messages and mark them read; who talked to whom | OP, CC, MC, AG | `mm-state` | The same figure wherever it is shown; reading never changes it; AG: messages addressed to it only |

## Files

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `file.write` | Put a file in the mission's shared folder, or in an agent's workdir | OP, CC, AG | `mm-isolation` | Contained in the shared folder or the workdir; no symlink escapes; An agent's workdir: OP only, besides the agent itself |
| `file.read` (read) | Read the mission's shared files and their history, or an agent's workdir | OP, CC, MC | `mm-isolation` | The same figure wherever it is shown; reading never changes it; Contained in the shared folder or the workdir; no symlink escapes; An agent's workdir: OP and MC only |

## Schedules

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `schedule.create` | Have a message or job delivered later or repeatedly | OP, CC, MC, AG | `cp-scheduler` | OP in the cockpit or through CC; The schedule invariants hold (see the schedule entity) |
| `schedule.cancel` | Stop a schedule | OP, CC, MC, AG | `cp-scheduler` | AG: its own schedules only; A cancelled file-backed schedule stays cancelled until its file is removed |
| `schedule.deliver` | Deliver what is due, waking the mission if needed | PLT | `cp-scheduler` | Each occurrence delivered once, even with two deliverers; Due occurrences missed while the platform was down are delivered when it is back; Retried a bounded number of times; the operator is told of a failure |
| `schedule.list` (read) | A mission's schedules | OP, CC, MC | `cp-scheduler` | The same figure wherever it is shown; reading never changes it |

## Background jobs

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `job.submit` | Run a script in the background | AG | `mm-jobs` | Submitted by writing a job file; its author is the file's owner |
| `job.run` | Start submitted jobs, and import file-backed schedules | PLT | `mm-jobs` | A job runs as its author, with no secrets, within a timeout; A file whose author cannot be established is refused; Its author is told the outcome |
| `job.control` | Cancel a running job, or restart a failed or cancelled one | MC | `mm-jobs` | A restarted job runs as its original author; The operator is told |
| `job.status` (read) | A mission's jobs and their state | MC | `mm-jobs` | The same figure wherever it is shown; reading never changes it |

## Objectives

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `objectives.edit` | Change the objective tree | CC, MC | `mm-state` | No duplicate ids, unknown parents or cycles |
| `task.create` | Add a task under an objective | AG, MC | `mm-state` | Under an existing objective |
| `task.update` | Record progress on a task | AG, MC | `mm-state` | Assignee, creator, objective owner or MC only |
| `kpi.record` | Record a KPI's value | AG, CC | `mm-state` | AG: KPIs of objectives it owns; CC: KPIs assessed by judgement |
| `cost.allocate` | Attribute one's spend to objectives | AG | `mm-state` | Only one's own spend; To existing objectives |
| `objectives.progress` (read) | Objectives, tasks and KPIs, and their progress | OP, CC, MC | `mm-state` | The same figure wherever it is shown; reading never changes it |

## Images

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `image.create` | Make images for the mission's work | AG | `mm-tools` | Within the per-call budget; Spend counts against the mission |

## Copilot

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `copilot.ask` | Talk to one's copilot | OP | `cp-copilot` | One's own copilot only; Within the copilot's limits; spend counts against the operator |
| `copilot.propose` | Propose a change for the operator to confirm | CC, MC | `cp-copilot` | Validated against the action's schema when proposed and again when carried out; The label the operator sees is written by the server from the validated proposal; MC: issues and resource requests |
| `copilot.confirm` | Accept a copilot's proposal | OP | `cp-copilot` | Carried out once, even if confirmed twice; Carried out with the proposer's rights, never more; The proposer is told the outcome |
| `copilot.dismiss` | Refuse a copilot's proposal | OP | `cp-copilot` | The proposer is told |
| `copilot.settings` | Configure one's own copilot | OP | `cp-copilot` |  |
| `copilot.limits` | Set one's own copilot's limits | OP | `cp-copilot` |  |
| `copilot.history` (read) | What one's copilot did: its turns, transcripts, model calls, files and usage | OP | `cp-copilot` | The same figure wherever it is shown; reading never changes it; One's own copilot only |
| `copilot.wake` | Run a copilot when its mailbox has news | PLT | `cp-copilot` | Within the copilot's limits; One turn per copilot at a time |

## Platform and account

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `issue.track` | Report and follow bugs and ideas about MAGI | CC, MC | `cp-copilot` | Search freely; every write (file, comment, close) is a proposal the operator confirms; An issue from a mission is marked as such |
| `oversight.alert` | Sample resources, raise alerts, send the daily report | PLT | `cp-oversight` | An alert is raised once per episode, not on every sample; One report per user per day, even across restarts |
| `platform.catalog` (read) | Templates, models and tools on offer | OP, CC | `cp-api` | The same figure wherever it is shown; reading never changes it |
| `session.sign-in` | Start using the cockpit | OP | `cp-edge` |  |
| `session.sign-out` | Stop using the cockpit | OP | `cp-edge` |  |

## Entry classes

Entry points that serve no product operation declare one of these classes instead. Adding a class is a baseline change, approved like an operation.

| Class | What | Why no operation |
|---|---|---|
| `infrastructure` | Health check, the browser's client configuration, CSP violation reports | Serve the platform's hosting and the browser, not an actor's request |
| `developer` | Run controls of the local dashboard (start, step, stop) | Local development only; the cockpit does not use them |
| `sub-agent` | Tools inside a sub-agent that an agent's tool call starts | They act within the calling operation, on the agent's behalf and within its budget |
| `housekeeping` | Evicting idle sessions, pruning old records | Keep the platform's own resources bounded; no actor asks for them |
| `retired` | An entry point kept only to refuse a request the product no longer supports | It must answer with a refusal rather than disappear |
