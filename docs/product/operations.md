<!-- Generated from packages/agent-config/src/baseline/ by `npm run docs:baseline`. Edit the catalog, not this file. -->

# Operations

**Approved 2026-11-19.** What actors can ask MAGI to do, kept by hand: the catalog states what MAGI is meant to do, and every push is reconciled against it, each deviation resolved as a code fix or a catalog edit the product owner approves. Each operation has **one** implementation in the code (its home), in the component named here, and every entry point that serves it calls that home, adding only who may ask and how the result is shown ([code-structure practice](../practices/code-structure.md), "One operation, one home"). "(read)" marks a figure shown to its actors, "(planned)" one not built yet.

## Definitions

**D1. Operation.** Something an actor can ask MAGI to do, or a figure it can ask to see (read). Requests with the same rules are one operation, whatever their entry point; different rules make different operations, even on the same data. Each operation has one home: the code every entry point serving it calls.

**D2. Rule.** A requirement on how an operation behaves, which its home enforces whoever asks: who may ask, what must be true first, what it does, or what happens on failure. A rule for one actor only starts with that actor ("AG: its own schedules only"). A reviewer checks the home against the rules, and a test that enforces one names it.

**D3. Actor.** Whoever reaches an entry point directly and decides for itself what to ask ([actors.md](actors.md)). An operation lists only the actors that can ask for it.

**D4. Asking through someone else** does not make an actor: the one who reaches the entry point is the actor, and a rule records the path ("AG asks through MC").

**D5. Wider authority is a rule, not an actor** ("ADM: all missions").

**D6. Confirmation is a rule, not an operation** ("CC: a proposal the operator confirms"). A copilot's proposal serves the operation it asks for.

**D7. Entry point.** Every place a request enters MAGI: a route, a tool, a copilot action, a Tool API name, a timer or event, and a file the daemon reads as a request (a job in `shared/jobs/pending/`, a schedule in `shared/schedules/`). Each declares the operation it serves, or an entry class; for a file request, the code that reads the file declares it.

**D8. A step started only by another operation** names it (started by) and needs no entry point of its own; the trace checks that the parent's entry points reach it.

**D9. Planned.** An operation the product needs and the code does not provide yet; the deviations the trace reports for it are expected until it is built.

**D10. Journeys** are an actor's goals end to end, the operator's and the agents' ([journeys.md](journeys.md)). Every operation an operator, a copilot or an agent asks for appears in at least one; only the platform's own may have none.

## Missions

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `mission.create-draft` | Start a mission as an editable draft | OP, CC | `cp-mission-ops` | Valid id, owned by the requester; Nothing runs; Replaced by `template.create` when editable templates ship |
| `mission.edit-draft` | Change a draft before launch | OP, CC | `cp-mission-ops` | Validated as a launch would validate it; A write based on an outdated version is refused; Replaced by `template.edit` when editable templates ship |
| `mission.launch` | Start a mission from a draft or a template | OP, CC | `cp-mission-ops` | Only a draft, or a template: a draft is then created first, with `mission.create-draft`'s checks; Only once, even if asked twice at the same moment; Capped before any machine starts; A failure leaves the mission in `error` with its reason, and no orphaned resources; CC: a proposal the operator confirms |
| `mission.suspend` | Stop a mission's machine, keeping its work | OP, CC | `cp-mission-ops` | Only a running mission |
| `mission.resume` | Bring a suspended or failed mission back | OP, CC | `cp-mission-ops` | Works whatever happened to the old machine; on the default machine and the existing volume; For a mission in `error`, CC diagnoses first, then may run this restore on its own, within a recovery budget the platform counts per mission; A failed attempt is never repeated without a new diagnosis; CC hands over to the operator, with its analysis and a plan, when the budget is spent, when it is unsure of the cause, or when the fix would change cost or size, delete anything or touch data |
| `mission.reconcile` (planned) | Keep the stored status in step with the machine's actual state | PLT | `cp-mission-ops` | On a timer, one home; An unplanned stop becomes `error` with its reason, and the operator is told; Never during a resize or another claimed transition; Reading a mission never changes it |
| `mission.wake` | Start a stopped machine so due work is delivered Started by `schedule.deliver`. | PLT | `cp-machines` | Starts the machine as it is; never moves the mission to a new image or config (that is `mission.resume`); Wakes a suspended mission too; it stays running; The operator is told what woke it |
| `mission.change-config` | Change a mission's agents, prompts, models, settings, files or limits; or the control copilot's model and limits | OP, CC, MC | `cp-mission-ops` | Applied while the mission runs; suspension is a last resort, only for a change that needs all activity stopped (a change of machine size or of the agents roster); A change to an agent's mental map waits until that agent is paused; nothing else is stopped; Validated as a launch; A write based on an outdated version is refused; The operator is told what changed; OP: their own control copilot's model and limits (it belongs to no mission) |
| `mission.repair` | Correct the mission's record of its machine and volume from the provider's actual state | CC | `cp-machines` | Ids are taken from the provider, never from the request; Never creates or deletes a machine or a volume; CC: a proposal the operator confirms |
| `mission.archive` (planned) | End a mission: stop all its costs, keep its results readable | OP | `cp-mission-ops` | Until it is built, a mission ends suspended; Missions are not deleted (decision D-6, 2026-09-12) |
| `mission.status` (read) | A mission's state, machine and roster, and the reason for an error | OP, CC, MC, AG | `cp-mission-ops` | The same figure wherever it is shown; reading never changes it; AG: its own mission's roster only |
| `mission.read-config` (read) | A mission's stored configuration | OP, CC, MC | `cp-api` | The same figure wherever it is shown; reading never changes it; No secret values |
| `mission.log` (read) | The daemon's log, for diagnosis | OP, CC, MC | `mm-monitor` | The same figure wherever it is shown; reading never changes it; No secret values; Bounded in size |
| `template.browse` (read) (planned) | The templates on offer and everything each holds | OP, CC | `cp-mission-ops` | The same figure wherever it is shown; reading never changes it; Every template is visible to every operator |
| `template.create` (planned) | A new template: blank, cloned from a template, or from a mission | OP, CC | `cp-mission-ops` | A unique name; From a mission: its configuration, team files and agents' mental maps, never its conversations; only a mission the requester owns; Presets come from files in the repository, loaded at install |
| `template.edit` (planned) | Change any part of a template, including copying skills from any template or mission | OP, CC | `cp-mission-ops` | Validated as a launch would validate it; A write based on an outdated version is refused; Presets are read-only: clone one to change it |
| `mission.platform-task` | Run a platform task on the mission machine: housekeeping the mission's agents must not be able to do, such as keeping a read-only copy of a repository | PLT | `mm-jobs` | Only task kinds shipped in the mission image run; the control plane chooses the kind, its schedule and its parameters, never the code; Parameters must match the kind's schema; A task runs as the platform user, never with the daemon's secrets; Agents can read a task's output but never write it; A failure keeps the last good output, marked stale; repeated failures raise an anomaly; Only the platform admin changes a mission's platform tasks |

## Spend and machine

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `mission.set-spend-cap` | Set the most a mission may spend | OP, CC, MC | `cp-mission-ops` | Never above the ceiling; Takes effect without a restart; A cap above current spend lifts a budget pause; The operator is told |
| `mission.set-ceiling` | Set the most anyone may set the cap to | OP | `cp-mission-ops` | OP up to the platform maximum; ADM above it; Not reachable by any copilot or agent |
| `spend.report` (read) | Spend against cap and ceiling: in total, per agent, over time, and runtime by machine shape; for one mission or all of one's missions | OP, CC, MC | `cp-mission-ops` | The same figure wherever it is shown; reading never changes it; Scope: one mission, or all of one's own missions; ADM: all missions; MC: its own mission only; One calculation behind every figure shown, always the same figure; Both copilots receive regular cost reports |
| `machine.upgrade` | Run on a bigger machine for a while, then go back | MC, PLT | `cp-machines` | AG asks through MC; Within the duration and daily caps; PLT reverts it on time; The operator is told |
| `machine.reset-upgrade-allowance` | Reset the cumulative upgrade cap | OP | `cp-machines` | Not reachable by any copilot or agent |

## Agents and the agent loop

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `agent.dispatch` | Decide which agent or copilot runs next, and start its turn when it has news | PLT | `mm-daemon` | Only an agent with unread mail; Never a paused agent, nor one cooling down after a model error; Nothing while the mission's spend has reached its cap; One turn per agent at a time; New mail during a turn is picked up after it; CC: within the copilot's own limits |
| `agent.turn` | Run one turn: build the prompt, call the model, run the tools, record cost Started by `agent.dispatch`. | PLT | `mm-agent-loop` | The prompt holds the agent's role, its mental map and the regions the platform manages; Every turn ends, within the agent's limits and a wall-clock timeout; Spend counts against the mission; Tool arguments are checked against the tool's schema; When the supervisor's message started the turn and the agent did not answer it, the supervisor is told |
| `agent.reflect` | Compact an agent's memory when its context grows too large or its turns stop producing output Started by `agent.turn`. | PLT | `mm-agent-loop` | Keeps the mental map and the conversation's history readable; Spend counts against the mission |
| `agent.remember` | Edit one's own mental map | AG | `mm-agent-loop` | Sections with an id only; Regions the platform manages are not editable by the agent |
| `agent.shell` | Run a command in one's own workspace | AG, MC, CC, SUB | `mm-tools` | As the agent's own OS user, with no secrets in its environment; Bounded in time and output; CC: in its own folder only, until the copilots' shell privileges are designed; SUB: the Research loop runs shell commands today; whether a sub-agent that reads web pages should is undecided |
| `web.search` | Search the web | AG, SUB, JOB | `mm-tools` | Bounded in size and time; Spend counts against the mission |
| `web.fetch` | Fetch a page or a document, or inspect an image | AG, SUB, JOB | `mm-tools` | Never reaches an internal address, at any redirect; Bounded in size and time; Spend counts against the mission |
| `web.browse` | Drive a browser through a site | AG, SUB | `mm-tools` | Through the egress proxy; never an internal address; Bounded in time; the browser is closed; Spend counts against the mission |
| `web.research` | Research a question with a sub-agent | AG, JOB | `mm-tools` | The sub-agent acts with the agent's identity and budget; Spend counts against the mission |
| `agent.investigate` (planned) | Investigate one question with a sub-agent in a clean context | AG, JOB | `mm-tools` | The sub-agent acts with the calling agent's identity, tools and budget, but none of its history; It reviews code in a read-only reference copy kept by a platform task; Its answer matches the caller's schema, or the call fails; Spend counts against the mission |
| `data.query` | Query a data provider | JOB | `mm-tools` | The provider's key never reaches the caller |
| `agent.pause` | Stop one agent's dispatch | OP, CC, MC | `mm-daemon` | Takes effect before the agent's next turn; Holds across restarts until someone resumes the agent; Agents never pause a teammate |
| `agent.resume` | Restart one agent's dispatch | OP, CC, MC | `mm-daemon` | Takes effect before the agent's next turn |
| `agent.history` (read) | What an agent did and why: its turns, transcripts, model calls, mental map and memories | OP, CC, MC, AG | `cp-records` | The same figure wherever it is shown; reading never changes it; AG: its own memories only; OP: their own control copilot only |

## Messages

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `message.send` | Give an agent work or information | OP, MC, AG, JOB | `mm-state` | Recipients on the roster; Wakes the recipient; May carry a file the operator uploaded |
| `message.read` (read) | Read messages and mark them read; who talked to whom | OP, CC, MC, AG | `mm-state` | The same figure wherever it is shown; reading never changes it; AG: messages addressed to it only |

## Files

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `file.write` | Write or edit a file in the mission's shared folder, or in an agent's workdir | OP, CC, AG | `mm-isolation` | Contained in the shared folder or the workdir; no symlink escapes; An agent's workdir: OP only, besides the agent itself |
| `file.read` (read) | Browse and read the mission's shared files and their history, or an agent's workdir | OP, CC, MC | `mm-isolation` | The same figure wherever it is shown; reading never changes it; Contained in the shared folder or the workdir; no symlink escapes; An agent's workdir: OP and MC only |
| `file.upload` | Put a file into the mission for the agents | OP | `mm-isolation` | Contained in the shared folder; Bounded in size |
| `file.download` (read) | Download a file or a folder from the mission | OP | `mm-isolation` | The same figure wherever it is shown; reading never changes it; Contained in the shared folder or the workdir; no symlink escapes; Bounded in size |

## Schedules

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `schedule.create` | Have a message or job delivered later or repeatedly | CC, MC, AG | `cp-scheduler` | OP asks through CC only; AG: by writing a schedule file; its author is the file's owner; The schedule invariants hold (see the schedule entity) |
| `schedule.cancel` | Stop a schedule | OP, CC, MC, AG | `cp-scheduler` | AG: its own schedules only, by removing the schedule file; A cancelled file-backed schedule stays cancelled until its file is removed |
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
| `image.create` | Make images for the mission's work | AG, SUB | `mm-tools` | Within the per-call budget; Spend counts against the mission |

## Interactive apps

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `app.declare` | Serve a program for the operator to use in a browser: its name, its kind (a notebook, a Gradio app, a site) and its files | AG | `mm-apps` | Declared by writing a request file into `shared/apps/requests/`; its owner is the file's owner, as for jobs; The platform builds the command line for each kind; an agent does not supply one; Re-declaring one's own app replaces it; another agent's app is refused |
| `app.run` | Start declared apps, watch them, and stop them | PLT | `mm-apps` | An app runs as its owner, with no secrets, like a job; The platform gives it its port (`$PORT`) and its path (`$BASE_PATH`); It listens on 127.0.0.1 only, and the machine refuses connections to its port from any other machine and from any OS user but the daemon and its owner; Watched by its process and by a regular check that it answers: one that exits or stops answering is restarted, at most a few times an hour, then `failed`, and its owner told; Stopped when the mission is suspended, when the daemon restarts, and after the idle time unopened; nothing restarts by itself |
| `app.control` | Start or stop an app | OP, MC, AG | `mm-apps` | AG: its own apps only; At most a few apps of a mission run at once; starting one more is refused, with the running ones named; The owner is told when someone else stops its app |
| `app.status` (read) | A mission's apps: their state, owner, when each was last opened, its memory | OP, MC, AG | `mm-apps` | The same figure wherever it is shown; reading never changes it |
| `app.open` | Use an app in the browser | OP | `cp-apps` | Served from the apps host, never from the cockpit's address; Only the mission's owner gets in: checked when the app is opened, then by a signed session of at most 12 hours on every request, WebSockets included; Opening a stopped app starts it, within the limit on apps running at once; A link in the mission cockpit, or a URL to copy: it works for the mission's owner in another tab; anyone else is sent to sign in |

## Copilot

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `copilot.ask` | Talk to one's copilot | OP | `cp-copilot` | One's own copilot only; Within the copilot's limits; spend counts against the operator |
| `copilot.confirm` | Accept a copilot's proposal | OP | `cp-copilot` | Carried out once, even if confirmed twice; Validated against the action's schema when proposed and again when carried out; the label the operator sees is written by the server; Carried out with the proposer's rights, never more; The proposer is told the outcome |
| `copilot.dismiss` | Refuse a copilot's proposal | OP | `cp-copilot` | The proposer is told |

## Platform and account

| Id | Intent | Actors | Home | Rules that hold for every actor |
|---|---|---|---|---|
| `issue.track` | Report and follow bugs and ideas about MAGI | CC, MC | `cp-copilot` | Search freely; every write (file, comment, close) is a proposal the operator confirms; An issue from a mission is marked as such |
| `oversight.alert` | Sample resources, raise alerts, send the daily report | PLT | `cp-oversight` | An alert is raised once per episode, not on every sample; One report per user per day, even across restarts; CC receives the platform's reports and alerts; MC those about its mission |
| `platform.offerings` (read) | Templates, models and tools on offer | OP, CC | `cp-api` | The same figure wherever it is shown; reading never changes it |
| `session.sign-in` | Start using the cockpit | OP | `cp-edge` |  |
| `session.sign-out` | Stop using the cockpit | OP | `cp-edge` |  |

## Entry classes

Entry points that serve no product operation declare one of these classes instead. Adding a class is a baseline change, approved like an operation.

| Class | What | Why no operation |
|---|---|---|
| `infrastructure` | Health check, the browser's client configuration, CSP violation reports | Serve the platform's hosting and the browser, not an actor's request |
| `developer` | Run controls of the local dashboard (start, step, stop) | Local development only; the cockpit does not use them |
| `proposal` | The copilot tool that carries a proposed action to the operator | Each action it carries is an entry point of its own, tagged with the operation it asks for (D6) |
| `feed` | Keepalives and change feeds that push updates to the open event streams of a route | Part of the route they serve, which declares the operation |
| `housekeeping` | Evicting idle sessions, pruning old records | Keep the platform's own resources bounded; no actor asks for them |
| `retired` | An entry point kept only to refuse a request the product no longer supports | It must answer with a refusal rather than disappear |
