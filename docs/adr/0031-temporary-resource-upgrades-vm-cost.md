# ADR-0031 — Temporary mission-machine resource upgrades

**Status**: Accepted — remaining open questions are implementation-time details.
**Sprint**: 28g
**Date**: 2026-09-18
**Related**: [ADR-0032](0032-proactive-resource-oversight.md) — the control-plane copilot's
cross-resource monitoring. Designed together, likely shipped together, but a separate concern; its
VM-tier alert and daily report read the dataset produced by Decision 1 below.

---

## Context

The default mission machine is `shared` CPU, 1 CPU, 1024 MB (`fly-machines.ts:182-186`). That is too
small for missions that run real compute, which have caused OOM crashes (issue #31), but a bigger
default would waste money for the (large) part of mission time that isn't compute-bound. Fly bills
per second, so a short excursion to a big tier is cheap: performance-1x costs ~$0.045/h against
~$0.008/h for our 1 GB shared default (~5.5×; ~16× the 256 MB shared-cpu-1x preset), so a 15-minute burst
costs about $0.011.

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
  body: "Requesting performance, 2 CPUs, 8 GB for 45 min: 10 GB in-memory pandas transform, CPU-bound.")
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
    durationMinutes: Type.Integer({ minimum: 1, maximum: 60, description: "Required, no default. Minutes to hold this machine before auto-revert unless renewed (max 60)" }),
    reason: Type.String({ description: "Why this is needed — shown to the operator" }),
    requestedByAgentId: Type.Optional(Type.String({ description: "Agent id who asked for this, if any" })),
  }),
  async execute(_id, args) { /* controlPlaneFetch("/api/mission-copilot/resources/upgrade", ...) */ },
};
```

The control-plane route (authenticated like the GitHub-proxy routes) **first validates the requested
shape** — against the Fly validity rules in Context and a **maximum machine size** (initially a
control-plane constant, default 4 CPUs / 16 GB; no agent tool can change it), rejecting (never
silently clamping) with the list of valid options — and against the **cumulative upgraded-runtime
cap** (Decision 7) — then performs stop →
`provisionMission(existingVolumeId, ...)` as `resumeMission()` does, and writes the Decision-1
segment. The limits apply no matter how the agent phrased the request: size is bounded per request,
Decision 7 bounds it cumulatively.

**Duration is mandatory and capped at 60 minutes per window.** There is no default: a request
without `durationMinutes`, or with more than 60, is rejected (never clamped), like any other invalid
shape. Work that needs longer must renew, which gives the mission-copilot a checkpoint at least
hourly. Renewal is the same tool called again while an upgrade is active: with the **same shape** it
only moves the expiry to now + `durationMinutes` (still ≤ 60; no restart, no suspend) and replaces
the reminder (Decision 5); with a **different shape** it is a new resize (hard suspend, as above).
Reverting to the default machine is the same stop/recreate path.

**3. Suspend is hard and immediate; the mission-copilot judges timing; the guidance lives in a new
platform skill.** No idle-wait mechanism — an agent asks for more memory *because* a computation is
already straining the machine, so waiting for idle would either wait for that very computation or
lose to the OOM. The mission-copilot has cross-agent visibility (team status, `ReadMissionLog`) that a
single requester lacks, so it decides whether to act now, ask the requester to wait, or decline.

Agents learn about all of this through a new **platform skill `request-resources`** (in
`packages/skills/`, discovered by the standard `discoverSkills()` tiering, so both worker agents and
the mission-copilot see it; ADR-0032's copilot skills are team skills for the control-plane copilot
only and do not reach mission agents). It has two sections and is the single source of truth for the
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
    estimated peak. Duration is required (no default) and at most 60 minutes: ask for the shortest that covers the work
    plus a margin, and expect to renew for longer jobs.
  - **The menu** (approximate cost; regenerated from the price table, never hand-edited):

    | Shape | kind | CPUs | RAM | ≈ $/h |
    |---|---|---|---|---|
    | default (today) | shared | 1 | 1 GB | 0.008 |
    | memory, small | shared | 1 | 2 GB | 0.015 |
    | memory, medium | shared | 2 | 4 GB | 0.03 |
    | memory, large | shared | 4 | 8 GB | 0.06 |
    | compute, small | performance | 1 | 4 GB | 0.06 |
    | compute, medium | performance | 2 | 8 GB | 0.12 |
    | compute, large | performance | 4 | 16 GB | 0.24 |

    Off-menu shapes are allowed within the validity rules and the maximum machine size; the menu is
    guidance, not an enforced list.
  - **The message:** to `mission-copilot`, stating kind, CPUs, RAM, duration, the job it's for and
    why that size (one line each) — exactly what the copilot needs to make the call without a
    follow-up question.
  - **What happens next:** the machine is hard-suspended and re-created, so every agent's current
    turn is aborted and running background jobs are re-run from scratch; wait for the copilot's
    reply before starting the heavy job, and be prepared for it to say "wait" or "no".
  - **At expiry:** you get a reminder about 10 min before. Reply whether you still need it and
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
    renew only if the job is still running (a same-shape renewal just extends the expiry, no restart), and don't let renewals become the default.
  - **Errors:** a rejected shape comes back with the valid options; correct and retry, don't loop.

`run-background/SKILL.md` gets a one-line pointer to it, since that is where agents decide to submit
heavy work.

**4. Notifications — three separate things.**
- **Mission cockpit and the agents involved:** posted by the control plane, not by the tool, because
  the requesting daemon is stopped by the resize itself before it could post anything. One mailbox
  message from `system` to `["user", "mission-copilot", requestedByAgentId?]`: the operator sees it in
  the mission's Conversations panel, and the mission-copilot and the requester learn, on restart, what
  happened, until when, and that their interrupted turns and jobs restart. When `requestedByAgentId`
  is set the body names that agent and its (sanitised, capped) reason.
- **Control-plane copilot:** informed silently via the Decision-1 dataset — no mailbox message, no
  wake, nothing shown in the control chat. ADR-0032's daily report reads it.
- **`copilot-{userId}` mailbox relay:** not used for routine requests/renewals; reserved for
  ADR-0032's alerts (`upgrade-cap-near`, `upgrade-cap-reached`, `upgrade-idle`, `resize-failure`).

**5. The request automatically schedules its own renewal reminder** — one `scheduled_messages`
document (`deliverAt = expiry − 10 min`, or halfway through a window shorter than that) with `to: ["mission-copilot", requestedByAgentId]` (just
the copilot if no requester). The mission-copilot decides whether to renew, but when there is a
requester it first consults that agent via `PostMessage` ("still need performance-2x? expiring in
10 min") since that agent knows whether its job is done. The requester also gets the reminder
directly so it isn't blocked on a busy copilot. The reminder is a nudge only; if ignored, expiry
proceeds as Decision 3 (hard revert).

**6. Extend `GetMissionStatus`** with current tier (`memoryMb`/`cpus`/`cpu_kind`) and time at that
tier, for ADR-0032 and for direct questions to the control-plane copilot.

**7. Cumulative upgraded-runtime cap (default 24 h), operator-resettable from a new section of the
cockpit Limits panel.** Time on any machine config other than the mission's default (Decision 1's
segments) counts toward a per-mission cap of **24 hours** (control-plane constant). Mechanics:
- **Derived, not counted.** Used time = sum of non-default-config segments with `startedAt` at or
  after the mission's `upgradedRuntimeResetAt` (a segment straddling the reset is clipped to it).
  There is no separate counter to keep in sync with the dataset. An in-progress segment counts to
  the end of its planned window, so an early revert gives the unused time back.
- **Enforced in the route, at request and renewal:** reject (never clamp) when `used + requested
  duration > cap`, with a message saying the cap is reached and that the operator can reset it in
  the cockpit. Because the whole window is checked up front, an upgrade can never run past the cap
  and nothing needs to force a revert mid-window. The mission-copilot relays the rejection to the
  user in the mission chat.
- **Reset is operator-only and structurally separate from every agent path**, following #49's
  ceiling: a new authenticated route `PATCH /:id/limits/upgrade-reset` on the Firebase-authed
  missions router sets `upgradedRuntimeResetAt = now` on the mission document (own writer function
  like `writeMissionCostCeiling`, never the shared config writer any tool uses) and posts a
  `postLimitsAudit` message to the mission ("Upgraded-runtime counter reset by the operator").
- **New "Upgraded compute time" section in the Limits panel** (`LimitsPanel.tsx`, alongside the
  spend cap and its ceiling): used / cap with a bar (same `pctColor`/`Minibar` styling as the spend
  cap), the last reset time, the currently active upgrade if any (shape and expiry), and a **Reset**
  button. `GET` limits (`missions.ts`, `LimitsData`) gains an `upgrades: {usedHours, capHours,
  resetAt, active}` block. The cap value itself stays a constant for now; editing it (and the
  maximum machine size) from this section is a later addition.
- ADR-0032's `upgrade-cap-near` alert fires at 80% of this cap, and `upgrade-cap-reached` (hard)
  fires when a request is rejected, so the operator hears about it before or as it happens.

**8. Lifecycle and safety of the resize itself** (gaps found while planning the implementation):
- **State** lives on the `missions` document as `upgrade: {cpuKind, cpus, memoryMb, expiresAt,
  segmentId, requestedByAgentId?, reminderId?, resizingSince?}`; absent means the mission is on its
  default machine (`mission.memoryMb`/`cpus`, shared CPU). `ProvisionOptions` gains `cpuKind`.
- **A resize in flight is invisible to the rest of the platform:** the mission stays `running`, but the
  cockpit's live-status refresh and the scheduler's wake-up both skip a mission whose resize claim is
  held (the machine is stopped on purpose; a scheduled message still lands in the mailbox and the new
  machine reads it on boot).
- **One resize at a time:** the route claims the mission with an atomic `findOneAndUpdate` that sets
  `resizingSince`; a concurrent request gets 409. A claim older than 5 min is treated as a failed
  resize (below). A resize to a *different shape*, or a revert, is rejected within 5 min of the
  previous one (cooldown), so a misbehaving copilot cannot repeatedly hard-suspend the mission;
  same-shape renewals are exempt.
- **Who executes the expiry revert:** a `revertExpiredUpgrades(db)` sweeper in the control plane's
  existing 1-min scheduler tick (`scheduler.ts`), also run once at startup, so a control-plane outage
  at expiry reverts late rather than never.
- **Suspend and destroy end the upgrade.** Destroy closes the segment and clears `upgrade`. A suspend of
  an upgraded mission first reverts it (stop, re-create the default machine on the same volume, stop
  again), so a suspended mission's stopped machine is always the default shape and every resume path
  works unchanged: the scheduler waking a suspended mission and the copilot's `resume_mission` both
  plain-start the existing machine (only the operator's resume route re-creates it), and neither must
  ever bring back an untracked upgraded machine.
- **A failed resize** (machine stopped or deleted but the re-create failed, or a stale claim): the
  mission is set to status `error` with an `errorMessage`, exactly like a failed resume; the segment is
  closed, `resize-failure` (ADR-0032) is raised, and the operator's Resume provisions the default
  machine. There is no attempt to restore the upgraded shape.

## Alternatives considered

- **Wait for the mission to be idle before resizing.** Needs new plumbing (`runningJobs` is
  unexported, `daemon.ts:145`) and doesn't solve the motivating case (see Decision 3).
- **Tier A tool: any agent calls the upgrade directly, no mediation.** Tried, then reverted: a
  single agent can't see what teammates are mid-task before triggering a hard suspend, and nobody
  coordinates renewals. The mission-copilot mediation costs one `PostMessage` round-trip.
- **Fixed `performance-Nx` preset enum.** Simplest tool signature, but the presets tie RAM to
  CPU: the smallest performance preset is 1 CPU / 2 GB at ~5.5× the default's hourly rate, so a
  memory-only OOM would force paying for CPU the job doesn't use. Free `cpuKind`/`cpus`/`memoryMb`
  with route-side validation lets an agent buy just the RAM it needs.
- **No expiry.** Unbounded time at an expensive tier and no check-in point; renewal gives an audited
  "do I still need this" checkpoint.
- **Fold machine runtime into the $ spend cap.** Couples two different signals and would make the
  static price table authoritative for enforcement.
- **Relay every request to `copilot-{userId}`.** Wakes a daemon for nothing exceptional; the silent
  dataset is enough for the routine case.

## Open questions

- **Making the maximum size and the 24 h cap operator-editable.** Deferred: start with constants (only
  the used-time reset ships, Decision 7). If a mission legitimately needs more, add editable
  per-mission values to the same Limits section (like #49's `maxCostCeilingUsd`), settable only
  through the Firebase-authenticated route, never from an execution-plane path.
- **Reminder buffer** — how long before expiry (about 10 min is illustrative; must fit comfortably
  inside a window that is at most 60 min).
- **Price/validity-table maintenance** — no staleness signal exists for either the price table
  (display-only, low stakes) or the shape-validity rules (a stale rule means Fly rejects a shape our
  route accepted; the route should surface Fly's error, not swallow it). Periodic manual check.
- **Cockpit tab shape** — per-mission drill-down, cross-mission table, or both; likely designed with
  the 28f usage dashboard.

## Consequences

- One new execution-plane → control-plane route: add a `docs/security/threat-model.md` entry
  (same shape as the GitHub-proxy boundary, not a new one).
- Touchpoints: new Tier B tool (`mission-copilot-tools.ts`); new control-plane route with a
  shape-validity table, maximum-size constant and cumulative-cap check, plus a tier-segment
  collection and cockpit tab; new `PATCH /:id/limits/upgrade-reset` route,
  `upgradedRuntimeResetAt` mission field and "Upgraded compute time" Limits-panel section
  (Decision 7); `GetMissionStatus` extension; new `request-resources` skill (with the shape menu generated
  from the price table) plus a pointer in `run-background`. No change to Tier A tools, spend-cap
  accounting, or the scheduler.
- Any agent can still cause a hard suspend indirectly by asking; the mission-copilot's judgment is
  the first line of defense, and the hard bounds behind it (maximum size, 24 h cumulative cap,
  operator-only reset) hold even if that judgment fails.
- Issue #31 (suspected OOM crash-loop) is likely closed or reframed once on-demand sizing exists.
