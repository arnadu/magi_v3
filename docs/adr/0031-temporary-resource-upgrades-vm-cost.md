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

- **No pricing API exists.** `flyctl platform vm-sizes` returns shapes only. Any price shown must
  come from a maintained static table (display-only, see Decision 1). `memory_mb`/`cpus` are
  independently overridable beyond a preset.
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
per tier a mission has run at (`{missionId, guestConfig, requestedByAgentId?, reminderId?,
startedAt, endedAt}`) and surface it in a **new cockpit tab showing runtime (not dollars) per
mission by time horizon (today / 7d / 30d / lifetime) and machine config**. The Fly price table is
only an optional "~$X estimated" annotation, never used for enforcement. `missionLifetimeCostUsd()`
and the #49 ceiling are untouched. This dataset is also ADR-0032's foundation.

**2. Two-step flow: any agent asks, the mission-copilot decides and executes.**

*Step 1* needs no new capability — any agent uses `PostMessage`:

```
PostMessage(to: ["mission-copilot"], subject: "Resource upgrade request",
  body: "Requesting performance-2x for ~3h to process a 10GB in-memory transform.")
```

*Step 2* is a new **Tier B** tool in `mission-copilot-tools.ts`, modeled on `SetMissionSpendCap`:

```ts
const requestResourceUpgrade: MagiTool = {
  name: "RequestResourceUpgrade",
  description:
    "Request a temporary upgrade to a bigger machine tier for a genuine compute burst. " +
    "Interrupts every currently-running agent turn and background job on this mission " +
    "(same as a manual suspend) — check whether anyone is mid-task before calling this. " +
    "Must be renewed before it expires or the mission reverts to its default tier; both " +
    "you and the requesting agent (if any) are reminded shortly before expiry.",
  parameters: Type.Object({
    tier: Type.Union([
      Type.Literal("performance-1x"), Type.Literal("performance-2x"), Type.Literal("performance-4x"),
    ]),
    durationHours: Type.Number({ description: "Hours to hold this tier before auto-revert unless renewed (max: TBD)" }),
    reason: Type.String({ description: "Why this is needed — shown to the operator" }),
    requestedByAgentId: Type.Optional(Type.String({ description: "Agent id who asked for this, if any" })),
  }),
  async execute(_id, args) { /* controlPlaneFetch("/api/mission-copilot/resources/upgrade", ...) */ },
};
```

The control-plane route (authenticated like the GitHub-proxy routes) performs stop →
`provisionMission(existingVolumeId, ...)` as `resumeMission()` does, and writes the Decision-1
segment. Renewal is the same tool called again against the current window (cancels and replaces the
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

- *Worker agents:* ask **before** starting known-heavy work, not mid-crash; include tier, duration and
  reason; what happens (hard suspend, other agents interrupted, background jobs re-run from scratch);
  answer the expiry consultation. If no `mission-copilot` is in the roster
  (`MISSION_COPILOT_ENABLED=false`), ask the user instead.
- *Mission-copilot:* how to judge timing, when to call `RequestResourceUpgrade`, consult the requester
  before renewing.

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
- **No expiry.** Unbounded time at an expensive tier and no check-in point; renewal gives an audited
  "do I still need this" checkpoint.
- **Fold machine runtime into the $ spend cap.** Couples two different signals and would make the
  static price table authoritative for enforcement.
- **Relay every request to `copilot-{userId}`.** Wakes a daemon for nothing exceptional; the silent
  dataset is enough for the routine case.

## Open questions

- **Confirmation / ceiling.** No dollar ceiling bounds upgrade cost, and the mission-copilot can
  request/renew indefinitely without operator confirmation (the mediation is a judgment layer, not
  a gate; no execution-plane agent has `ProposeAction` today — CR-07). Candidates: (a) an
  operator-set ceiling on cumulative upgraded runtime or renewal count, like #49 but in time
  (leaning); (b) confirm the first request only; (c) rely on ADR-0032's alert alone. Decide before
  implementation.
- **Default and maximum window length**, and whether total upgraded duration has a cap independent
  of renewals.
- **Reminder buffer** — how long before expiry (10–15 min is illustrative).
- **Selectable tiers** — full Fly catalog or the curated performance-1x/2x/4x set.
- **Price-table maintenance** — no staleness signal exists; periodic manual check (low stakes,
  display-only).
- **Cockpit tab shape** — per-mission drill-down, cross-mission table, or both; likely designed with
  the 28f usage dashboard.

## Consequences

- One new execution-plane → control-plane route: add a `docs/security/threat-model.md` entry
  (same shape as the GitHub-proxy boundary, not a new one).
- Touchpoints: new Tier B tool (`mission-copilot-tools.ts`); new control-plane route + tier-segment
  collection + cockpit tab; `GetMissionStatus` extension; new `request-resources` skill plus a
  pointer in `run-background`. No change to Tier A tools, spend-cap accounting, or the scheduler.
- Any agent can still cause a hard suspend indirectly by asking; safety rests on the
  mission-copilot's judgment, the same trust `SetMissionSpendCap` already carries.
- Issue #31 (suspected OOM crash-loop) is likely closed or reframed once on-demand sizing exists.
