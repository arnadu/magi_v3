<!-- Generated from packages/agent-config/src/baseline/ by `npm run docs:baseline`. Edit the catalog, not this file. -->

# Entities and their states

**Approved 2026-11-19.** What actors work with, each one's states, and the transitions the product intends. "Stored as" is the join with the code. A status write the code makes that is not a transition below is a finding, and so is a transition below that no code makes.

## Mission (`mission`)

Stored as `missions` (`MissionDoc`, field `status`).

A draft is a mission in state `draft`, until editable templates replace drafts: a mission will then start at `provisioning`. Budget pause is not a mission state: the mission keeps running and dispatches nothing until the cap is raised above the spend (see `mission.set-spend-cap`).

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
- `mission.capped`: A mission never runs without a spend cap, and the cap is never above its ceiling. *(not yet enforced; decided in ADR-0034)*
- `mission.way-out`: Whatever state a mission is in, the operator can get it out of that state from the cockpit: no state is a dead end. *(not yet enforced)*
- `mission.work-kept`: A mission's volume (its work) survives every transition. Missions are not deleted: suspend is the end state until archive exists (decision D-6); archive will stop all costs and keep the results readable. *(not yet enforced)*
- `mission.status-follows-machine`: The status the cockpit shows is the machine's real state: when a machine stops or fails on its own, the platform notices on a timer and updates the status (`mission.reconcile`). Looking at a mission never changes it. *(not yet enforced)*

## Agent (within a mission), and the copilots (`agent`)

Stored in: The mission's configuration (`agents`, the roster) and the daemon's dispatch state.

The agent loop is the operations `agent.dispatch`, `agent.turn` and `agent.reflect`. A turn's work is the agent's tool calls, each an operation of its own. The copilots are agents with privileged access; the control copilot belongs to no mission, runs on the control plane and is stored there.

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
- `agent.one-turn`: An agent runs at most one turn at a time. *(not yet enforced)*
- `agent.turn-ends`: Every turn ends, within the agent's limits and a wall-clock timeout. *(not yet enforced)*
- `agent.within-budget`: No turn starts once the mission's spend has reached its cap. *(not yet enforced)*
- `agent.pause-holds`: A pause holds until someone resumes the agent, across any restart of the mission (resume, upgrade, crash). *(not yet enforced)*
- `agent.no-teammate-control`: Agents never act on a teammate. A supervisor agent works with the agents it oversees through the mailbox only. *(not yet enforced)*

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
- `schedule.min-interval`: A recurring schedule fires at most every 5 minutes, whoever creates it. *(not yet enforced)*
- `schedule.roster`: Recipients are on the mission's roster. *(not yet enforced)*

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
- `job.as-author`: A job runs as its author, with no secrets, whether its author submitted it or scheduled it; a job schedule names only its author. *(not yet enforced; decided in ADR-0033)*

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
- `objective.well-formed`: Objectives and their tasks form one tree (no duplicate ids, unknown parents or cycles), and each is changed only by those entitled to: the objective tree by the copilots; a task by its assignee, its creator, the objective's owner or the mission copilot. *(not yet enforced)*

## Task (`task`)

Stored as `objectivesEvents` (`TaskEvent`).

A piece of work under an objective, with an assignee and a status; agents create and update tasks with their objectives tools. `objective.well-formed` covers who may change it. Its transitions are not yet specified.

| State | Meaning |
|---|---|
| `open` | Not started |
| `in-progress` | Being worked on |
| `blocked` | Waiting on something |
| `completed` | Done |
| `deferred` | Postponed |
| `cancelled` | Dropped |

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
- `message.wakes`: A message wakes its recipient. *(not yet enforced)*

## Turn (one agent's run from dispatch to its end) (`turn`)

Stored as `agentTurnStats` (`AgentTurnStats`, field `status`).

Its messages are in `conversationMessages`, one per step; its model calls are `llm-call`s.

| State | Meaning |
|---|---|
| `running` | Dispatched; its steps are being stored as they happen |
| `completed` (stored as `complete`) | Ended normally |
| `failed` | Ended on a model error, a limit or the wall-clock timeout, with the reason recorded |
| `interrupted` (stored as `aborted`) | Cut short by a crash or a restart of the daemon |

| From | Event | To | Who | Note |
|---|---|---|---|---|
| — | dispatched | `running` | PLT |  |
| `running` | ends normally | `completed` | PLT |  |
| `running` | a model error, a limit or the timeout | `failed` | PLT |  |
| `running` | the daemon crashes or restarts | `interrupted` | PLT | What happens next is an open decision (`turn.no-silent-loss`) |

Invariants:
- `turn.reconstructible`: Any turn can be reconstructed from what is stored: the prompt and mental map it started from, every model call, every tool call with its arguments and result, its cost, and how it ended. *(not yet enforced)*
- `turn.persisted-per-step`: Each step of a turn (a model answer, a tool result) is stored before the next step starts, so a crash loses at most the step in progress. *(not yet enforced)*
- `turn.no-silent-loss`: An interrupted turn is either resumed from its last stored step or closed with a recorded reason; it is never silently dropped or replayed from the start. *(not yet enforced; **open decision:** Resume from the last stored step (needs tools that are safe to repeat), or close the turn and start a new one)*

## Model call (`llm-call`)

Stored as `llmCallLog` (`LlmCallLogEntry`).

| State | Meaning |
|---|---|
| `recorded` | Its row (who, model, tokens, cost, time) and its full input and output are stored |
| `summarized` | Past the retention period: the full input and output are removed, the row is kept |

| From | Event | To | Who | Note |
|---|---|---|---|---|
| — | a model is called | `recorded` | PLT |  |
| `recorded` | the retention period ends | `summarized` | PLT |  |

Invariants:
- `llm-call.recorded`: Every model call made on a mission's behalf (by an agent, a copilot, a sub-agent, a tool or a job) is recorded with who made it, the model, tokens, cost and time, and its full input and output are kept for the retention period the operator sets. *(not yet enforced; decided in ADR-0017; **open decision:** The retention period and where the bodies are kept (MongoDB, the mission's volume, object storage); whether tool results are kept in full)*
- `llm-call.cost-counted`: Every recorded call's cost counts against its mission's spend. *(not yet enforced; decided in ADR-0017)*

## Template (planned: editable templates, on the roadmap) (`template`)

Stored in: Today: read-only files in `config/teams/` (ADR-0021). Planned: a database collection, with the preset templates loaded into it at install.

Everything needed to start a mission: its parameters, the roster, the objective tree, and each agent's prompt, tasks, initial mental map, tools and skills. Every template is visible to every operator.

| State | Meaning |
|---|---|

Invariants:
- `template.decoupled`: Once launched, a mission is independent of its template: a change to either never reaches the other. *(not yet enforced)*

## Mission machine (`machine`)

Stored as `machineSegments` (`MachineSegment`).

One stored segment per stretch the machine ran with one size; the runtime by size and the allowance are computed from them.

| State | Meaning |
|---|---|
| `default` | Running on the mission's own size |
| `upgraded` | Running bigger for a while |

| From | Event | To | Who | Note |
|---|---|---|---|---|
| `default` | upgrade | `upgraded` | MC |  |
| `upgraded` | revert on time | `default` | PLT |  |

Invariants:
- `machine.upgrade-bounded`: An upgrade reverts on time, and a mission's upgrades stay within the daily allowance until the operator resets it. *(not yet enforced; decided in ADR-0031)*

## Mental map (`mental-map`)

Stored in: Saved with the agent's conversation (`conversationMessages`).

An agent's working memory, in its prompt every turn.

| State | Meaning |
|---|---|

Invariants:
- `mental-map.platform-regions`: The regions the platform manages are written by the platform only; the agent edits its own sections. *(not yet enforced)*
- `mental-map.edit-between-turns`: An operator's or a copilot's edit to an agent's mental map never lands during that agent's turn. *(not yet enforced)*

## Mission file (`file`)

Stored in: The mission's volume: the shared folder and each agent's workdir, with the history of each file.

Who changed a file and when is the platform invariant `files.attributed`.

| State | Meaning |
|---|---|

## Interactive app (planned) (`app`)

Stored as `missionApps` (`MissionAppDoc`, field `status`).

A long-running program an agent serves on the mission machine for the operator to use in a browser: a notebook, a Gradio app, a static site. Declared by a request file the agent writes (`shared/apps/requests/`), like a job. Withdrawing the declaration stops the app and removes it.

| State | Meaning |
|---|---|
| `starting` | Declared or started; the platform is launching it and waiting for it to answer |
| `running` | Answering on its port |
| `stopped` | Stopped on request, when the mission was suspended or the daemon restarted, or after the idle time unopened; still declared |
| `failed` | Exited, or stopped answering, more often than the restart limit allows |

| From | Event | To | Who | Note |
|---|---|---|---|---|
| — | declare | `starting` | AG |  |
| `starting` | answers on its port | `running` | PLT |  |
| `starting` | exits or never answers, past the restart limit | `failed` | PLT | Its owner is told |
| `starting` | stop, mission suspended, or daemon restarted before it answers | `stopped` | OP, MC, AG, PLT | AG: its own apps |
| `running` | exits or stops answering, past the restart limit | `failed` | PLT | Its owner is told |
| `running` | stop | `stopped` | OP, MC, AG | AG: its own apps; its owner is told when someone else stops it |
| `running` | mission suspended, daemon restarted, or unopened past the idle time | `stopped` | PLT |  |
| `stopped` | start, or the operator opens it | `starting` | OP, MC, AG | AG: its own apps |
| `failed` | start, or the operator opens it | `starting` | OP, MC, AG | AG: its own apps |

Invariants:
- `app.loopback-only`: An app is reachable only through the apps host: it never listens on an address another machine can reach. *(not yet enforced)*
- `app.as-owner`: An app runs as its owner's OS user, with no secrets. *(not yet enforced)*
- `app.bounded`: No app runs while its mission is suspended or after the idle time unopened; no more than the limit run at once; a failing app is not restarted without limit. *(not yet enforced)*

## Resource alert (`alert`)

Stored as `resourceAlertState` (`AlertState`).

One per mission (or the platform) and category. The control copilot receives the platform's alerts and reports; the mission copilot those about its mission.

| State | Meaning |
|---|---|
| `raised` | The condition holds; its recipients were told |
| `cleared` | The condition no longer holds |

| From | Event | To | Who | Note |
|---|---|---|---|---|
| — | condition met | `raised` | PLT |  |
| `raised` | condition gone | `cleared` | PLT |  |
| `cleared` | condition met again | `raised` | PLT |  |

Invariants:
- `alert.once-per-episode`: An alert is raised once per episode, not on every sample, and the daily report is sent once per user per day, even across restarts. *(not yet enforced; decided in ADR-0032)*

## Platform-wide invariants

What holds across entities: the record of what happened, and what survives a restart.

- `files.attributed`: Every change to a mission's files is attributed to an agent and a turn. *(not yet enforced)*
- `platform.no-memory-only-state`: Every piece of state that decides what the platform does next (pauses, holds, cooldowns, claims, queued work) is stored, and rebuilt after a restart. *(not yet enforced)*
- `platform.changes-audited`: Every change to a mission by the operator, a copilot or the platform (configuration, cap, schedule, pause, machine) is recorded: who, what, when and why. *(not yet enforced)*
- `platform.failures-surface`: Every failure that stops work (a crashed turn, a timeout, a failed delivery, a failed provisioning) is recorded with its reason and reaches the operator. *(not yet enforced)*

## Security invariants

What must always hold for MAGI to be safe. The threats and trust boundaries they guard against are in [the threat model](../security/threat-model.md) and [the trust-boundaries table](../security/trust-boundaries.md).

- `sec.authenticated`: Every route and Tool API name requires an authenticated caller (a session, the admin key, the mission's monitor token, a job's tool token), except the entry points of the `infrastructure` class. *(enforced by runtime check in control-plane/src/auth.ts: createAuthMiddleware (session or admin key), runtime check in agent-runtime-worker/src/monitor-server.ts: tokenOk (the mission's monitor token, every route), runtime check in agent-runtime-worker/src/tool-api-server.ts: the job's bearer token, runtime check in control-plane/src/mission-copilot-router.ts: the mission's monitor token, a test)*
- `sec.authorized`: Every request about a mission is checked against the caller's right to that mission before it reaches the operation's home. *(enforced by runtime check in control-plane/src/mission-scope.ts: userFilter (owner, or any mission for an admin), runtime check in control-plane/src/proxy.ts: owner filter before forwarding to a mission machine, a test; **open decision:** `mission-resource-routes.ts` keeps a second copy of `userFilter`: one rule, two homes)*
- `sec.tenant-scoped`: Every database query on mission data is scoped to one mission, and to one user where the data is a user's; input supplies values, never operators or field names. *(enforced by runtime check in control-plane/src/mission-scope.ts: userFilter on mission queries, review; **open decision:** Nothing checks that input supplies values only (never an operator or a field name); a reviewer checks each new query)*
- `sec.no-secrets-to-agents`: No secret reaches an agent's or a job's environment, prompt, files or tool results. *(enforced by runtime check in agent-runtime-worker/src/tools.ts: runIsolatedToolCall (sudo child with PATH and HOME only), runtime check in agent-runtime-worker/src/job-runner.ts: startJob (minimal env and a scoped, revocable tool token), runtime check in agent-runtime-worker/src/tools/data-provider-proxy.ts: providers' keys stay in the daemon)*
- `sec.secrets-not-recorded`: No secret value is written to logs, conversations or model-call records. *(not yet enforced; **open decision:** Nothing enforces it yet: no redaction before logs, conversations or call records are written)*
- `sec.contained-paths`: Every path that comes from input is resolved inside its root, after following symlinks, before it is used. *(enforced by runtime check in agent-runtime-worker/src/safe-path.ts: resolveInside, readInside, writeFileInside, a test)*
- `sec.safe-egress`: Every outbound request to a URL an agent or the web can influence is checked against internal addresses, at every redirect. *(enforced by runtime check in agent-runtime-worker/src/ssrf.ts: resolveVetted; safe-http.ts: safeGet (every redirect), runtime check in agent-runtime-worker/src/tools/browse-web-egress-proxy.ts: the browser's egress proxy, a test)*
- `sec.input-validated`: Every input from outside a component's trust boundary is checked against a schema before it is used. *(enforced by runtime check in agent-runtime-worker/src/tool-args.ts: checkToolArguments (every tool call and Tool API request), runtime check in control-plane/src/copilot-actions.ts: parseActionPayload (every copilot action), runtime check in agent-config/src/loader.ts: the team config schema, a test)*
- `sec.untrusted-text-labelled`: Text written by agents or taken from the web, when placed in a more privileged actor's context, is marked as data, not instructions. *(enforced by runtime check in agent-runtime-worker/src/mental-map-regions.ts: file-fed regions labelled as data, runtime check in agent-runtime-worker/src/tools/fetch-url.ts: the banner on fetched content, a test; **open decision:** Anomaly text relayed into the copilots' inboxes is not yet marked (AN1, trust-boundaries.md))*
- `sec.output-safe`: Content written by agents or taken from the web is escaped or sandboxed wherever the cockpit shows it. *(enforced by runtime check in cockpit/src/markdown.ts: renderMarkdown (escapes text, allow-lists link schemes), runtime check in agent-runtime-worker/src/monitor-files.ts: handleDownload (SVG and HTML as attachments under a sandbox CSP), a test)*
- `sec.served-apart`: Code an agent serves live runs in the operator's browser from an origin other than the cockpit's, so it never acts with the operator's cockpit session; and one mission's app cannot reach another mission's app through that browser. *(not yet enforced; **open decision:** Planned with interactive apps: the apps host, its sign-in and the secret in each app's path are for the ADR)*
- `sec.least-privilege`: Each agent's tools and jobs run as its own OS user. Only the daemon may use `sudo`, only to become an agent's user, with a minimal environment. *(enforced by runtime check in agent-runtime-worker/src/tools.ts: runIsolatedToolCall (sudo -u the agent's user), runtime check in agent-runtime-worker/src/job-runner.ts: startJob (sudo -u the file owner's user), a test)*
- `sec.confirmed-effects`: Every change the control copilot makes, and every GitHub write from either copilot, is a proposal the operator confirms. The mission copilot changes only its own mission, within its ceilings, and reports each change to the operator. *(enforced by runtime check in control-plane/src/copilot-pending-routes.ts: /confirm (claims the action once, runs it as the proposer), runtime check in control-plane/src/copilot-actions.ts: parseActionPayload (validated when proposed and again when carried out), review)*
