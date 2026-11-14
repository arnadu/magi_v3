# Entities and their states

**Draft, 2026-11-14.** What actors work with, each one's states, and the transitions the product
intends. "Stored as" is the join with the code: the collection and the canonical type in
`packages/agent-config/src/stored/`. A status write the code makes that is not a transition
below is a finding, and so is a transition below that no code makes.

## Mission

Stored as `missions` (`MissionDoc`, `MissionStatus`). A draft is a mission in state `draft`.

| From | Event | To | Who |
|---|---|---|---|
| — | create a draft | `draft` | OP, CC |
| — | create from a template, launching at once | `provisioning` | OP, CC |
| `draft` | launch | `provisioning` | OP, CC |
| `provisioning` | machine started | `running` | PLT |
| `provisioning` | provisioning failed | `error` | PLT |
| `running` | suspend | `suspended` | OP, CC |
| `suspended` | resume | `running` | OP, CC |
| `suspended` | a schedule falls due | `running` (woken; it stays running, and the operator is told why) | PLT |
| `running` | temporary upgrade, revert | `running` (machine replaced) | MC, PLT |
| `running` | upgrade or revert failed and the default machine could not be restored | `error` | PLT |
| `error` | resume on the default machine and the existing volume | `running` | OP; CC on its own within its recovery budget |
| `suspended` | archive (planned) | `archived` | OP |

Invariants:
- A mission never runs without a spend cap, and the cap is never above its ceiling.
- Every state other than `destroyed` has a way out that the operator can reach from the cockpit.
- A mission's volume (its work) survives every transition. Missions are not deleted: suspend is
  the end state until archive exists (decision D-6); archive will stop all costs and keep the
  results readable.
- A mission in `error` is recovered by the control copilot within a budget the platform enforces;
  beyond it, the copilot hands over to the operator. See `mission.resume`.

Budget pause is not a mission state: the mission keeps running and dispatches nothing until the
cap is raised above the spend (see `mission.set-spend-cap`).

## Agent (within a mission)

Defined in the mission's configuration (`agents`). A pause holds until someone resumes the agent,
across any restart of the mission (resume, upgrade, crash).

| From | Event | To | Who |
|---|---|---|---|
| active | pause | paused | OP, CC, MC |
| paused | resume | active | OP, CC, MC |

Agents never act on a teammate. A supervisor agent works with the agents it oversees through
the mailbox only.

## Schedule

Stored as `scheduled_messages` (`ScheduledMessageDoc`, `ScheduledMessageStatus`). Either a
message to agents or a job to run, one-off or recurring.

| From | Event | To | Who |
|---|---|---|---|
| — | create | `pending` | OP (in the cockpit, or through CC), CC, MC, AG |
| `pending` | falls due | `delivering` | PLT |
| `delivering` | delivered, one-off | `delivered` | PLT |
| `delivering` | delivered, recurring | `pending` (next occurrence) | PLT |
| `delivering` | delivery failed, retries left | `pending` | PLT |
| `delivering` | retries exhausted | `failed` (operator told) | PLT |
| `pending` | cancel | `cancelled` | OP, CC, MC, AG (own schedules) |

Invariants: a recurring schedule fires at most every 5 minutes, whoever creates it; recipients
are on the mission's roster; a job schedule runs only as its author.

## Pending action (a copilot's proposal)

Stored as `copilotPendingActions`.

| From | Event | To | Who |
|---|---|---|---|
| — | propose | proposed | CC, MC (issues and resource requests) |
| proposed | confirm | executed or failed (the proposer is told either way) | OP |
| proposed | dismiss | dismissed (the proposer is told) | OP |

## Background job

Files under `shared/jobs/`; the daemon's private record is authoritative.

| From | Event | To | Who |
|---|---|---|---|
| — | submit | pending | AG, PLT (a job schedule) |
| pending | started, as its author | running | PLT |
| running | finished | done or failed (the author is told) | PLT |
| running | daemon restarted | recovered: running or failed | PLT |

## Objective and task

Stored in the objectives store. Objectives: `proposed`, `active`, `achieved`, `abandoned`.
Tasks: `open`, `in-progress`, `blocked`, `completed`, `deferred`, `cancelled`. The objective
tree is edited by CC and MC; tasks by their assignee, their creator, the objective's owner, or
MC.

## Message

Stored as `mailbox`. Sent by OP, MC, AG, and by PLT for alerts and audits; read or unread per
recipient. A message wakes its recipient.
