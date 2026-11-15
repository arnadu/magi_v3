<!-- Generated from packages/agent-config/src/baseline/ by `npm run docs:baseline`. Edit the catalog, not this file. -->

# Entities and their states

**Draft since 2026-11-14, awaiting the product owner's approval.** What actors work with, each one's states, and the transitions the product intends. "Stored as" is the join with the code. A status write the code makes that is not a transition below is a finding, and so is a transition below that no code makes.

## Mission (`mission`)

Stored as `missions` (`MissionDoc`, field `status`).

A draft is a mission in state `draft`. Budget pause is not a mission state: the mission keeps running and dispatches nothing until the cap is raised above the spend (see `mission.set-spend-cap`).

| State | Meaning |
|---|---|
| `draft` | An editable configuration; nothing runs, nothing is spent |
| `provisioning` | Its machine is being created |
| `running` | Its machine runs; agents are dispatched within the spend cap |
| `suspended` | Its machine is stopped on request; its work is kept |
| `error` | Something failed or the machine stopped without a suspend; the reason is recorded |
| `archived` (planned) | Ended: no costs, results readable |

| From | Event | To | Who | Note |
|---|---|---|---|---|
| — | create a draft | `draft` | OP, CC |  |
| — | create from a template, launching at once | `provisioning` | OP, CC |  |
| `draft` | launch | `provisioning` | OP, CC |  |
| `provisioning` | machine started | `running` | PLT |  |
| `provisioning` | provisioning failed | `error` | PLT |  |
| `running` | suspend | `suspended` | OP, CC |  |
| `suspended` | resume | `running` | OP, CC |  |
| `suspended` | a schedule falls due | `running` | PLT | Woken; it stays running, and the operator is told why |
| `running` | temporary upgrade, or its revert | `running` | MC, PLT | Machine replaced |
| `running` | the machine stopped or disappeared without a suspend (crash, out of memory, provider) | `error` | PLT | With the reason; the operator is told |
| `suspended` | the machine is found running | `running` | PLT |  |
| `running` | upgrade or revert failed and the default machine could not be restored | `error` | PLT |  |
| `error` | resume on the default machine and the existing volume | `running` | OP, CC | CC on its own, within its recovery budget |
| `suspended` | archive | `archived` | OP | Planned |

Invariants:
- `mission.capped`: A mission never runs without a spend cap, and the cap is never above its ceiling.
- `mission.way-out`: Every state has a way out that the operator can reach from the cockpit.
- `mission.work-kept`: A mission's volume (its work) survives every transition. Missions are not deleted: suspend is the end state until archive exists (decision D-6); archive will stop all costs and keep the results readable.
- `mission.status-follows-machine`: The stored status follows the machine's actual state, kept in step by the platform on a timer (`mission.reconcile`), never by reading a mission.
- `mission.error-recovery`: A mission in `error` is recovered by the control copilot within a budget the platform enforces; beyond it, the copilot hands over to the operator. See `mission.resume`.

## Agent (within a mission) (`agent`)

Stored in: The mission's configuration (`agents`, the roster) and the daemon's dispatch state.

The agent loop is the operations `agent.dispatch`, `agent.turn` and `agent.reflect`. A turn's work is the agent's tool calls, each an operation of its own.

| State | Meaning |
|---|---|
| `idle` | No turn running; dispatched when it has unread mail |
| `running` | A turn is running |
| `paused` | Never dispatched until resumed |
| `cooling-down` | Its last turn ended on a model error; not dispatched until the cooldown ends |
| `held` | The mission's spend has reached its cap; not dispatched until the cap is raised |

| From | Event | To | Who | Note |
|---|---|---|---|---|
| `idle` | dispatched: unread mail, within budget | `running` | PLT |  |
| `running` | turn ends | `idle` | PLT |  |
| `running` | turn ends on a model error | `cooling-down` | PLT |  |
| `cooling-down` | cooldown ends | `idle` | PLT | Dispatched again without new mail if mail is still unread |
| `idle` | the mission's spend reaches its cap | `held` | PLT |  |
| `held` | the cap is raised above the spend | `idle` | OP, CC, MC | Through `mission.set-spend-cap` |
| `idle` | pause | `paused` | OP, CC, MC |  |
| `running` | pause | `paused` | OP, CC, MC | The running turn finishes; no next turn |
| `paused` | resume | `idle` | OP, CC, MC |  |

Invariants:
- `agent.one-turn`: An agent runs at most one turn at a time.
- `agent.turn-ends`: Every turn ends, within the agent's limits and a wall-clock timeout.
- `agent.within-budget`: No turn starts once the mission's spend has reached its cap.
- `agent.pause-holds`: A pause holds until someone resumes the agent, across any restart of the mission (resume, upgrade, crash).
- `agent.no-teammate-control`: Agents never act on a teammate. A supervisor agent works with the agents it oversees through the mailbox only.
- `agent.own-identity`: An agent's tools run as its own OS user, with no secrets in their environment.

## Schedule (`schedule`)

Stored as `scheduledMessages` (`ScheduledMessageDoc`, field `status`).

Either a message to agents or a job to run, one-off or recurring.

| State | Meaning |
|---|---|
| `pending` | Waiting for its next occurrence |
| `delivering` | Claimed for delivery |
| `delivered` | A one-off, delivered |
| `failed` | Retries exhausted; the operator was told |
| `cancelled` | Stopped on request |

| From | Event | To | Who | Note |
|---|---|---|---|---|
| — | create | `pending` | OP, CC, MC, AG | OP in the cockpit, or through CC |
| `pending` | falls due | `delivering` | PLT |  |
| `delivering` | delivered, one-off | `delivered` | PLT |  |
| `delivering` | delivered, recurring | `pending` | PLT | Next occurrence |
| `delivering` | delivery failed, retries left | `pending` | PLT |  |
| `delivering` | retries exhausted | `failed` | PLT | The operator is told |
| `pending` | cancel | `cancelled` | OP, CC, MC, AG | AG: its own schedules only |

Invariants:
- `schedule.min-interval`: A recurring schedule fires at most every 5 minutes, whoever creates it.
- `schedule.roster`: Recipients are on the mission's roster.
- `schedule.job-author`: A job schedule runs only as its author.

## Pending action (a copilot's proposal) (`pending-action`)

Stored as `copilotPendingActions` (`PendingAction`).

| State | Meaning |
|---|---|
| `proposed` | Waiting for the operator |
| `executed` | Confirmed and carried out |
| `failed` | Confirmed; carrying it out failed |
| `dismissed` | Refused by the operator |

| From | Event | To | Who | Note |
|---|---|---|---|---|
| — | propose | `proposed` | CC, MC | MC: issues and resource requests |
| `proposed` | confirm | `executed` | OP | The proposer is told |
| `proposed` | confirm, execution fails | `failed` | OP | The proposer is told |
| `proposed` | dismiss | `dismissed` | OP | The proposer is told |

## Background job (`job`)

Stored in: Files under `shared/jobs/`; the daemon's private record is authoritative.

| State | Meaning |
|---|---|
| `pending` | Submitted, not started |
| `running` | Running as its author |
| `done` | Finished |
| `failed` | Finished with an error, or lost |
| `cancelled` | Stopped on request while running |

| From | Event | To | Who | Note |
|---|---|---|---|---|
| — | submit | `pending` | AG, PLT | PLT: a job schedule |
| `pending` | started, as its author | `running` | PLT |  |
| `running` | finished | `done` | PLT | The author is told |
| `running` | finished with an error | `failed` | PLT | The author is told |
| `running` | daemon restarted, job lost | `failed` | PLT | A job still running after the restart stays `running` |
| `running` | cancel | `cancelled` | MC | The operator is told |
| — | restart a failed or cancelled job, as a new job | `pending` | MC | Same script and author as the original |

Invariants:
- `job.as-author`: A job runs as its author, with no secrets.

## Objective (`objective`)

Stored as `objectivesGoals` (`GoalsFile`).

The objective tree is edited by CC and MC. Its transitions are not yet specified.

| State | Meaning |
|---|---|
| `proposed` | Suggested, not yet adopted |
| `active` | Being worked on |
| `achieved` | Met |
| `abandoned` | Dropped |

Invariants:
- `objective.tree`: The objective tree has no duplicate ids, unknown parents or cycles.

## Task (`task`)

Stored as `objectivesEvents` (`TaskEvent`).

Its transitions are not yet specified.

| State | Meaning |
|---|---|
| `open` | Not started |
| `in-progress` | Being worked on |
| `blocked` | Waiting on something |
| `completed` | Done |
| `deferred` | Postponed |
| `cancelled` | Dropped |

Invariants:
- `task.who-updates`: A task is updated by its assignee, its creator, the objective's owner, or MC.

## Message (`message`)

Stored as `mailbox` (`MailboxMessage`).

Read or unread per recipient.

| State | Meaning |
|---|---|
| `unread` | Not yet read by a recipient |
| `read` | Read |

| From | Event | To | Who | Note |
|---|---|---|---|---|
| — | send | `unread` | OP, MC, AG, PLT | PLT: alerts and audits |
| `unread` | read by the recipient | `read` | AG, MC |  |

Invariants:
- `message.wakes`: A message wakes its recipient.
