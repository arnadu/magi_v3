# ADR-0031 — Temporary mission-machine resource upgrades

**Status**: Proposed — several open questions below need settling before implementation.
**Sprint**: TBD (candidate: right after 28f, alongside the Jupyter/webapp-exposure feature)
**Date**: 2026-09-18
**Related**: [ADR-0032](0032-proactive-resource-oversight.md) — the control-plane copilot's
cross-resource monitoring. Designed together, likely shipped together, but a separate concern; its
VM-tier alert and daily report read the dataset produced by Decision 1 below.

---

## Context

The default mission machine is `shared` CPU, 1 CPU, 1024 MB (`fly-machines.ts:182-186`). That is too
small for missions that run real compute, which have caused OOM crashes (issue #31), but a bigger
default would waste money for the (large) part of mission time that isn't compute-bound. Fly bills
per second, so a short excursion to a big tier is cheap: performance-1x is ~16× the per-second rate
of shared-cpu-1x (~$0.045/h vs ~$0.0065/h), so a 15-minute burst costs about $0.011.

**Facts the design relies on (all verified in code/Fly docs):**

- **No pricing API exists.** `flyctl platform vm-sizes` returns preset shapes only. Any price shown
  must come from a maintained static table (display-only, see Decision 1): a named preset's price
  plus ~$5 per 30 days per extra GB of RAM.
- **`cpu_kind`, `cpus` and `memory_mb` are independently settable; the presets are just defaults**,
  but not every combination is valid. Per Fly's pricing page (re-verify at implementation):
  `shared` allows cpus ∈ {1,2,4,6,8} with 256 MB × cpus up to 2 GB × cpus of RAM; `performance`
  allows cpus ∈ {1,2,4,6,8,10,12,14,16} with 2 GB × cpus up to 8 GB × cpus; RAM moves in 256 MB
  steps. `shared` CPUs get only ~6% baseline CPU (bursting), so they suit memory-heavy but
  CPU-light work; CPU-bound work needs `performance`.
- **Machines can't be reliably resized in place.** `resumeMission()` (`missions.ts:~1560-1600`)
  already stops/destroys the machine and calls `provisionMission(existingVolumeId, ...)` to
  re-create it on the same volume; conversation state is in MongoDB and the workspace is on the
  volume, so nothing is lost. An upgrade is the same operation with a different `guest` config.
- **A machine stop is a hard interruption, and this ADR inherits that rather than fixing it.**
  In-flight agent turns are aborted cleanly and recorded as aborted (`wireAbortSignal`), but the
  work itself doesn't finish; background jobs have no drain step (`stopJobRunner()` only clears the
  scan interval) and die with the machine, then are re-run from scratch by `recoverOrphanedJobs()`
  (max 2 attempts). This is exactly what a manual operator suspend does today.
- **Cost tracking is LLM-only** (`computeCost()`, `MissionStats`, `missionLifetimeCostUsd()`); no
  machine-cost field exists anywhere. The spend cap (#49) therefore does **not** bound upgrade cost.
- **Tier A vs Tier B tools.** Tier A tools go to every agent (`agent-runner.ts:577-618`, filterable
  via `disabledTools`). Tier B tools are added by `getAdditionalTools(agentId)` only for
  `MISSION_COPILOT_AGENT_ID` (`daemon.ts:721-724`). `SetMissionSpendCap`, `CreateScheduledMessage`
  and the GitHub-proxy tools are all Tier B.
- **Template for the new tool: `SetMissionSpendCap`** (`mission-copilot-tools.ts:745-761`) — one
  `Type.Object` schema, an `execute()` that calls a route, then `auditPost()` posts
  `{from: MISSION_COPILOT_AGENT_ID, to: ["user"]}` into the mission's mailbox. It calls the
  loopback monitor server, which can't resize a machine (only the control plane holds
  `FLY_API_TOKEN_MACHINES`).
- **Precedent for execution-plane → control-plane calls: the GitHub-proxy tools**
  (`controlPlaneFetch()`, `mission-copilot-tools.ts:1160-1219`) send the per-mission `MONITOR_TOKEN`
  as `x-monitor-token`; the control plane's `verifyMissionToken` (`mission-copilot-router.ts:31-55`)
  re-derives the token from `MONITOR_SIGNING_KEY` + claimed `missionId` and rejects on mismatch. A
  new route under this middleware needs no new auth mechanism.
- **Reminders need no new infrastructure.** `scheduled_messages` supports one-off `deliverAt`
  timestamps and multi-recipient `to: string[]` (`scheduler.ts:41-52, 108-229`); the mission-copilot
  is a normal runtime `teamConfig.agents[]` entry, so it is a valid recipient.
- **Posting to the mailbox ≠ a visible chat bubble.** `GET /api/copilot/history` returns only
  messages where `from` or `to` is `"user"`; a relay to `copilot-{userId}` just wakes the control-plane
  copilot. `AnomalyRecorder.record()` shows the silent alternative: always persist to
  `missionAnomalies` (queryable), relay to the mailbox only for exceptional cases.
- **`GetMissionStatus`** (`copilot-tools.ts:190-225`) doesn't return `memoryMb`/`cpus`/tier.

## Decision

**1. Track machine runtime as its own dataset, decoupled from the $ spend cap.** Record a segment
per machine config a mission has run at (`{missionId, guestConfig, requestedByAgentId?, reminderId?,
startedAt, endedAt}`) and surface it in a **new cockpit tab showing runtime (not dollars) per
mission by time horizon (today / 7d / 30d / lifetime) and machine config**. The Fly price table is
only an optional "~$X estimated" annotation, never used for enforcement. `missionLifetimeCostUsd()`
and the #49 ceiling are untouched. This dataset is also ADR-0032's foundation.

**2. Two-step flow: any agent asks, the mission-copilot decides and executes.**

*Step 1* needs no new capability — any agent uses `PostMessage`, stating the exact shape it wants
(from the skill's menu, Decision 3):

```
PostMessage(to: ["mission-copilot"], subject: "Resource upgrade request",
  body: "Requesting performance, 2 CPUs, 8 GB for ~3h: 10 GB in-memory pandas transform, CPU-bound.")
```

*Step 2* is a new **Tier B** tool in `mission-copilot-tools.ts`, modeled on `SetMissionSpendCap`:

```ts
const requestResourceUpgrade: MagiTool = {
  name: "RequestResourceUpgrade",
  description:
    "Request a temporary upgrade to a bigger machine (CPU kind, CPUs, RAM) for a genuine compute " +
    "burst. Interrupts every currently-running agent turn and background job on this mission " +
    "(same as a manual suspend) — check whether anyone is mid-task before calling this. " +
    "Must be renewed before it expires or the mission reverts to its default machine; both " +
    "you and the requesting agent (if any) are reminded shortly before expiry. Invalid or " +
    "over-ceiling shapes are rejected with the list of valid options.",
  parameters: Type.Object({
    cpuKind: Type.Union([Type.Literal("shared"), Type.Literal("performance")]),
    cpus: Type.Integer({ description: "Number of CPUs (valid values depend on cpuKind)" }),
    memoryMb: Type.Integer({ description: "RAM in MB, multiple of 256, within the valid range for cpuKind × cpus" }),
    durationHours: Type.Number({ description: "Hours to hold this machine before auto-revert unless renewed (max: TBD)" }),
    reason: Type.String({ description: "Why this is needed — shown to the operator" }),
    requestedByAgentId: Type.Optional(Type.String({ description: "Agent id who asked for this, if any" })),
  }),
  async execute(_id, args) { /* controlPlaneFetch("/api/mission-copilot/resources/upgrade", ...) */ },
};
```

The control-plane route (authenticated like the GitHub-proxy routes) **first validates the requested
shape** — against the Fly validity rules in Context and an operator-set ceiling on CPUs and RAM,
rejecting (never silently clamping) with the list of valid options — then performs stop →
`provisionMission(existingVolumeId, ...)` as `resumeMission()` does, and writes the Decision-1
segment. The ceiling applies no matter how the agent phrased the request, so it bounds cost
exposure per request (see the Confirmation open question). Renewal is the same tool called again against the current window (cancels and replaces the
reminder, Decision 5); reverting to the default tier is the same stop/recreate path.

**3. Suspend is hard and immediate; the mission-copilot judges timing; the guidance lives in a new
platform skill.** No idle-wait mechanism — an agent asks for more memory *because* a computation is
already straining the machine, so waiting for idle would either wait for that very computation or
lose to the OOM. The mission-copilot has cross-agent visibility (team status, `ReadMissionLog`) that a
single requester lacks, so it decides whether to act now, ask the requester to wait, or decline.

Agents learn about all of this through a new **platform skill `request-resources`** (in
`packages/skills/`, discovered by the standard `discoverSkills()` tiering, so both worker agents and
the mission-copilot see it; ADR-0032's `resource-oversight` skill is control-plane-copilot-only and
does not reach mission agents). It has two sections and is the single source of truth for the
request-message contract between them:

- *Worker agents:*
  - **When:** ask **before** starting known-heavy work, not mid-crash. Signs you need it: loading
    data larger than roughly half the current RAM, a previous OOM/killed process, a job you expect
    to run for hours. Don't ask for a routine job that fits today's 1 GB shared machine. Check
    current memory first (`free -m`) instead of guessing.
  - **What to ask for:** the *cheapest* shape that fits. RAM is usually the constraint, so prefer
    `shared` with more RAM for memory-heavy, CPU-light work (data loading, pandas, notebooks);
    choose `performance` only for sustained CPU-bound work (model training, big numerical jobs),
    since `shared` CPUs are throttled to a small baseline. Leave ~25% RAM headroom over the
    estimated peak. Ask for the shortest duration that covers the work plus a margin.
  - **The menu** (approximate cost; regenerated from the price table, never hand-edited):

    | Shape | kind | CPUs | RAM | ≈ $/h |
    |---|---|---|---|---|
    | default (today) | shared | 1 | 1 GB | 0.007 |
    | memory, small | shared | 1 | 2 GB | 0.015 |
    | memory, medium | shared | 2 | 4 GB | 0.03 |
    | memory, large | shared | 4 | 8 GB | 0.06 |
    | compute, small | performance | 1 | 4 GB | 0.06 |
    | compute, medium | performance | 2 | 8 GB | 0.12 |
    | compute, large | performance | 4 | 16 GB | 0.24 |

    Off-menu shapes are allowed within the validity rules and operator ceiling; the menu is
    guidance, not an enforced list.
  - **The message:** to `mission-copilot`, stating kind, CPUs, RAM, duration, the job it's for and
    why that size (one line each) — exactly what the copilot needs to make the call without a
    follow-up question.
  - **What happens next:** the machine is hard-suspended and re-created, so every agent's current
    turn is aborted and running background jobs are re-run from scratch; wait for the copilot's
    reply before starting the heavy job, and be prepared for it to say "wait" or "no".
  - **At expiry:** you get a reminder about 10-15 min before. Reply whether you still need it and
    for how long; if your job is done, say so so the machine can revert.
  - **No mission-copilot in the roster** (`MISSION_COPILOT_ENABLED=false`): ask the user instead.
- *Mission-copilot:*
  - **Deciding:** check who is mid-task (team status, `ReadMissionLog`, running jobs) before acting.
    Options: act now, ask the requester (and others) to wrap up or checkpoint first, ask the
    requester to wait, or decline or downsize if a smaller shape fits (e.g. `shared` + RAM instead
    of `performance`). Sanity-check the size against the stated job; an oversized request costs money.
  - **Acting:** call `RequestResourceUpgrade` with `requestedByAgentId`, then tell the requester and
    anyone interrupted what happened and when the machine reverts.
  - **Renewing:** at the reminder, consult the requester (`PostMessage`) rather than deciding alone;
    renew only if the job is still running, and don't let renewals become the default.
  - **Errors:** a rejected shape comes back with the valid options; correct and retry, don't loop.

`run-background/SKILL.md` gets a one-line pointer to it, since that is where agents decide to submit
heavy work.

**4. Notifications — three separate things.**
- **Mission cockpit:** `auditPost` as in `SetMissionSpendCap` (`from: MISSION_COPILOT_AGENT_ID`,
  `to: ["user"]`); when `requestedByAgentId` is set the body names that agent and its reason.
- **Control-plane copilot:** informed silently via the Decision-1 dataset — no mailbox message, no
  wake, nothing shown in the control chat. ADR-0032's daily report reads it.
- **`copilot-{userId}` mailbox relay:** not used for routine requests/renewals; reserved for
  ADR-0032's exceptional-pattern alert (e.g. excessive renewals).

**5. The request automatically schedules its own renewal reminder** — one `scheduled_messages`
document (`deliverAt = expiry − buffer`) with `to: ["mission-copilot", requestedByAgentId]` (just
the copilot if no requester). The mission-copilot decides whether to renew, but when there is a
requester it first consults that agent via `PostMessage` ("still need performance-2x? expiring in
10 min") since that agent knows whether its job is done. The requester also gets the reminder
directly so it isn't blocked on a busy copilot. The reminder is a nudge only; if ignored, expiry
proceeds as Decision 3 (hard revert).

**6. Extend `GetMissionStatus`** with current tier (`memoryMb`/`cpus`/`cpu_kind`) and time at that
tier, for ADR-0032 and for direct questions to the control-plane copilot.

## Alternatives considered

- **Wait for the mission to be idle before resizing.** Needs new plumbing (`runningJobs` is
  unexported, `daemon.ts:145`) and doesn't solve the motivating case (see Decision 3).
- **Tier A tool: any agent calls the upgrade directly, no mediation.** Tried, then reverted: a
  single agent can't see what teammates are mid-task before triggering a hard suspend, and nobody
  coordinates renewals. The mission-copilot mediation costs one `PostMessage` round-trip.
- **Fixed `performance-Nx` preset enum.** Simplest tool signature, but the presets tie RAM to
  CPU: the smallest performance preset is 1 CPU / 2 GB at ~16× the default's per-second rate, so a
  memory-only OOM would force paying for CPU the job doesn't use. Free `cpuKind`/`cpus`/`memoryMb`
  with route-side validation lets an agent buy just the RAM it needs.
- **No expiry.** Unbounded time at an expensive tier and no check-in point; renewal gives an audited
  "do I still need this" checkpoint.
- **Fold machine runtime into the $ spend cap.** Couples two different signals and would make the
  static price table authoritative for enforcement.
- **Relay every request to `copilot-{userId}`.** Wakes a daemon for nothing exceptional; the silent
  dataset is enough for the routine case.

## Open questions

- **Confirmation / ceiling.** No dollar ceiling bounds upgrade cost, and the mission-copilot can
  request/renew indefinitely without operator confirmation (the mediation is a judgment layer, not
  a gate; no execution-plane agent has `ProposeAction` today — CR-07). The per-request CPU/RAM
  ceiling (Decision 2) bounds the *size* of one request but not how long or how often. Candidates
  for the rest: (a) an operator-set ceiling on cumulative upgraded runtime or renewal count, like
  #49 but in time (leaning); (b) confirm the first request only; (c) rely on ADR-0032's alert alone.
  Decide before implementation. Also open: where the operator sets the CPU/RAM ceiling and its
  default (a per-mission setting like #49's `maxCostCeilingUsd`, set only via the cockpit's
  authenticated Limits route, never from an execution-plane path).
- **Default and maximum window length**, and whether total upgraded duration has a cap independent
  of renewals.
- **Reminder buffer** — how long before expiry (10–15 min is illustrative).
- **Price/validity-table maintenance** — no staleness signal exists for either the price table
  (display-only, low stakes) or the shape-validity rules (a stale rule means Fly rejects a shape our
  route accepted; the route should surface Fly's error, not swallow it). Periodic manual check.
- **Cockpit tab shape** — per-mission drill-down, cross-mission table, or both; likely designed with
  the 28f usage dashboard.

## Consequences

- One new execution-plane → control-plane route: add a `docs/security/threat-model.md` entry
  (same shape as the GitHub-proxy boundary, not a new one).
- Touchpoints: new Tier B tool (`mission-copilot-tools.ts`); new control-plane route with a
  shape-validity table and operator CPU/RAM ceiling, plus a tier-segment collection and cockpit
  tab; `GetMissionStatus` extension; new `request-resources` skill (with the shape menu generated
  from the price table) plus a pointer in `run-background`. No change to Tier A tools, spend-cap
  accounting, or the scheduler.
- Any agent can still cause a hard suspend indirectly by asking; safety rests on the
  mission-copilot's judgment, the same trust `SetMissionSpendCap` already carries.
- Issue #31 (suspected OOM crash-loop) is likely closed or reframed once on-demand sizing exists.
