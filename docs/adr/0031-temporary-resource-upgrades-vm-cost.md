# ADR-0031 — Temporary mission-machine resource upgrades

**Status**: Proposed — records a direction and the research behind it; several open questions
below need to be settled before implementation starts. Not yet assigned to a numbered sprint.
**Sprint**: TBD (candidate: right after 28f, alongside or ahead of the Jupyter/webapp-exposure
feature — see MAGI_V3_ROADMAP.md)
**Date**: 2026-09-18

**Related**: [ADR-0032](0032-proactive-resource-oversight.md) (proactive multi-resource oversight
by the control-plane copilot) was split out from an earlier combined draft of this ADR — the two
are designed together (ADR-0032's VM-tier alert and daily report both read the dataset this ADR's
Decision 1 produces) and likely ship in the same push, but are genuinely separate concerns: this
ADR is about scaling *one mission's own machine* on request; ADR-0032 is about the control-plane
copilot's *ongoing, cross-resource* monitoring of every mission a user owns.

---

## Context

The default mission machine is `cpu_kind: "shared"`, `cpus: 1`, `memory_mb: 1024`
(`packages/control-plane/src/fly-machines.ts:182-186`) — a fixed compromise chosen for the common
case (LLM calls, light I/O). It is too small for missions that run genuine compute (a data-science
Python stack, large in-memory transforms), which have caused real OOM crashes (the motivating
report for issue #31). Running every mission at a bigger tier by default would fix that but waste
money on the (large) fraction of mission time that isn't compute-bound.

**Fly's actual pricing (fetched live from `fly.io/docs/about/pricing`, no pricing API exists —
see below):**

| Tier | Per-second | Per-hour (continuous) |
|---|---|---|
| shared-cpu-1x, 256MB (Fly default) | $0.00000078 | ~$0.0028 |
| shared-cpu-1x, 1024MB (our current default) | ~$0.0000018 | ~$0.0065 |
| performance-1x, 2048MB | $0.00001242 | ~$0.045 |

Performance-1x is ~16× the per-second rate of shared-cpu-1x, but billed per-second — a 15-minute
compute burst on performance-1x costs about **$0.011**. This is the entire economic case for
"cheap by default, upgrade only for the burst": short excursions to a much bigger tier are cheap in
absolute terms; running that tier continuously is not.

**No pricing API exists.** `flyctl platform vm-sizes` (backed by a real Fly API call) returns the
named preset catalog — shapes only, no price:

```
shared-cpu-1x/2x/4x/6x/8x  → 1/2/4/6/8 cores, 256/512/1024/1536/2048 MB
performance-1x through -16x → 1..16 cores, 2048MB..32768MB
```

`memory_mb`/`cpus` are independently overridable beyond a preset's own default (confirmed via
`flyctl machine run --help`'s separate `--vm-cpus`/`--vm-memory` flags, and by the fact our own
code already overrides memory above `shared-cpu-1x`'s 256MB default). Price is not independently
queryable — it must be a maintained static table sourced from Fly's docs, not a live lookup. That
table can go stale if Fly changes prices; there is no way to detect that automatically today.

**Fly Machines can't be reliably resized in place.** `resumeMission()`
(`packages/control-plane/src/missions.ts:~1560-1600`) already documents why: "the Fly PATCH API for
env-var updates on stopped machines is unreliable" — it deletes the stopped machine and
re-provisions a fresh one against the *same* volume instead. A resource upgrade is architecturally
the same operation: stop (or destroy-if-already-stopped) → `provisionMission(missionId,
{existingVolumeId, memoryMb, cpus, cpu_kind})`. Nothing is lost — conversation state lives in
MongoDB, workspace lives on the Fly Volume, neither touches the machine itself. This means most of
the low-level mechanism already exists; what's missing is the orchestration and safety wrapper
around calling it mid-mission.

**A machine stop today is a hard interruption, not a graceful drain — confirmed directly, and this
ADR deliberately inherits that behavior rather than building around it.** `wireAbortSignal()`
(`daemon-boot/abort-signal.ts`) does abort in-flight agent turns cleanly on shutdown — each
dispatched agent's `AbortController` is wired to the daemon's own signal
(`orchestrator.ts:467-525`), and the daemon waits for those aborted turns' own cleanup
(`Promise.allSettled`) before exiting — so a turn interrupted by a stop is recorded as aborted, not
corrupted. But the *work itself* (an in-flight Bash computation) does not get to finish, and
**background jobs have no drain step at all**: `stopJobRunner()` only clears the job-scan interval
(`daemon.ts:522-549`); nothing signals or waits for an in-flight `magi-job` subprocess, which simply
dies with the machine. This is recovered exactly like any other unclean restart, via the existing
`recoverOrphanedJobs()` (`job-recovery.ts:68-182`) on next boot — the job is re-run from scratch (not
resumed), up to `MAX_JOB_RECOVERY_ATTEMPTS = 2` before being permanently failed. **This is already
exactly what happens today when an operator manually suspends a running mission** — this ADR does
not introduce a new interruption risk, it reuses the existing one, and pushes the responsibility for
avoiding a bad-timing suspend onto whichever agent calls the tool (see Decision 3), not new
platform orchestration.

**Revised again: any agent must be able to *ask* for an upgrade, but the mission-copilot is the one
who decides and executes it — a two-step, mediated flow, not direct Tier A access.** An earlier
revision of this ADR gave every agent a new Tier A tool calling straight through to the control
plane. On reflection this put the disruptive decision (a hard suspend, per Decision 3, that
interrupts every other agent's and job's current work) in the hands of whichever single agent
happened to want more memory — with no visibility into what anyone *else* on the team was doing at
that moment. The mission-copilot already has (or can gather) that cross-agent mission awareness;
an individual worker agent generally doesn't. Routing the actual decision through the copilot also
supplies, for free, the judgment/approval layer the earlier direct-access design lacked, without
needing new `ProposeAction`-style confirmation infrastructure (see the Confirmation open question,
now softened but not eliminated by this).

**Mechanically, this needs no new capability for the requesting agent at all.** It asks via
`PostMessage(to: ["mission-copilot"], ...)` — a tool every agent already has (Tier A,
`mailbox.ts:183`). Only the mission-copilot needs a new tool, and it belongs exactly where every
other mutating mission-copilot tool already lives: **Tier B**, in `mission-copilot-tools.ts`,
appended via `getAdditionalTools(agentId)` gated on `agentId === MISSION_COPILOT_AGENT_ID`
(`daemon.ts:721-724`), verified alongside `agent-runner.ts:577-618`'s Tier A/B split. This reverts
the tool's location back to matching `SetMissionSpendCap`/`CreateScheduledMessage`'s own precedent
exactly — the earlier Tier A revision is recorded under Alternatives rather than silently dropped.

**`SetMissionSpendCap`'s exact shape is the concrete template for the tool's mechanics** (verified,
`mission-copilot-tools.ts:745-761`): a single-purpose `Type.Object` parameter schema, an `execute()`
that calls a route and posts an audit message via the shared `auditPost(subject, body)` helper
(`:198-206`), which posts `{ from: MISSION_COPILOT_AGENT_ID, to: ["user"] }` — accurate again now
that only the copilot calls it. `SetMissionSpendCap` calls its own mission's loopback monitor server
(`monitorPost("/set-budget", ...)`) — that never leaves the execution plane. A machine resize can't:
only the control plane holds `FLY_API_TOKEN_MACHINES`. The closest working precedent for an
execution-plane call that *does* reach the control plane is the GitHub-proxy tools
(`ListGithubIssues`/`ReportGithubIssue`, `mission-copilot-tools.ts:1160-1219`): `controlPlaneFetch()`
sends the same per-mission `MONITOR_TOKEN` (`x-monitor-token` header) already used for loopback
calls to `${controlPlaneUrl}/api/mission-copilot/...`; the control-plane side
(`mission-copilot-router.ts:31-55`, `verifyMissionToken`) re-derives the expected token from its own
`MONITOR_SIGNING_KEY` + the claimed `missionId` and rejects (401) on any mismatch. No new auth
mechanism needed; just a new route under this same middleware.

**Cost tracking today is LLM-only, and stays that way.** Verified directly: `computeCost()`
(`agent-runtime-worker/src/llm-call-log.ts:160-183`) derives cost purely from token counts;
`MissionStats` (`agent-stats.ts:111-123`) has no machine-cost field; `missionLifetimeCostUsd()`
(`limits.ts:289-296`) sums only LLM cost; `fly-machines.ts` has no cost-related fields at all. An
earlier draft of this ADR proposed folding machine compute cost into this same $ figure so the
existing spend cap would bound it. **That's deliberately rejected** (see Decision) — LLM $ spend
and machine wall-clock runtime are different signals answering different questions, and merging
them would mean the maintained Fly price table (see above) has to be *authoritative for
enforcement*, not just a friendly display estimate. The mission-wide spend cap therefore still does
**not** bound the cost risk of a resource upgrade — that risk is managed instead through the
bounded-window-plus-renewal mechanic and visibility (Decisions 3-4), not a dollar ceiling.

**Posting to `mailbox` and appearing in the operator's copilot chat are two different things —
verified directly, not assumed.** `GET /api/copilot/history` (`copilot-router.ts:247-273`) only
returns mailbox documents where `from` or `to` is literally `"user"` — a `from:"system",
to:["copilot"]` anomaly relay is excluded by construction, and never becomes a visible chat bubble
on its own. It only wakes the copilot daemon (`mailboxRepo.listUnread(agentId)`); whether the
copilot then produces a user-visible reply is a per-category judgment call in its own prompt
(`config/teams/copilot.yaml`'s anomaly-handling section, reinforced by the `incident-triage`
skill), not something the platform enforces. This matters directly for Decision 4: routing every
routine upgrade/renewal through the mailbox-relay mechanism would be new, mostly-pointless traffic
(waking a daemon for something with no exceptional content), not something that would otherwise
"leak" into the operator's chat if left out.

**The codebase's existing pattern for "queryable data the copilot can use later, without waking it
now" is a separate collection, never a mailbox message.** `AnomalyRecorder.record()` demonstrates
this split directly (`anomaly.ts:91-99` vs. `109-133`): every anomaly is unconditionally persisted
to `missionAnomalies` (silent, queryable, feeds the Trace panel) completely independent of whether
it's *also* relayed via `mailbox`. The mailbox post is the only wake-triggering part. This ADR's
own Decision 1 dataset (`{missionId, guestConfig, startedAt, endedAt}`) is exactly this kind of
store — logging an upgrade/renewal there is "informing" the control-plane copilot in the same sense
`missionAnomalies` does, with no mailbox traffic and nothing to display anywhere, until ADR-0032's
oversight logic actually reads it.

**`GetMissionStatus` (the control-plane copilot's mission-inspection tool,
`copilot-tools.ts:190-225`) doesn't expose machine tier at all** — it returns status, `machineId`,
`privateIp`, and a live Fly state string, but no `memoryMb`/`cpus`/tier information. It would need
extending before the control-plane copilot could answer "what tier is this mission on, and since
when" even when explicitly alerted.

**The existing `/extend-budget` and `/set-budget` routes are the closest existing precedent** for
a "renew an allowance rather than force an expiry" mechanic: `/extend-budget`
(`monitor-routes/budget.ts:44-88`) reads the current persisted cap fresh, adds a delta, re-persists;
`SetMissionSpendCap` (`mission-copilot-tools.ts:745-761`) is the mission-copilot's tool wrapper
around the equivalent absolute-set route. Both are unconfirmed, single-call actions bounded only by
the operator-set ceiling from #49. Resource-upgrade requests mirror the *mechanic* (read the current
window fresh, extend it) but — since VM runtime deliberately isn't folded into that $ ceiling — sit
outside the trust boundary #49 actually enforces; see the Confirmation open question below.

**The cockpit has no existing view for machine-config or runtime data at all** — the closest
precedent is the per-user `/api/missions/stats` route (`missions.ts`, unread/spend/lastActivity per
mission) and the already-planned "usage dashboard" backlog item (Sprint 28f, per-user spend
history). Neither currently has any notion of machine tier or wall-clock runtime — this ADR's
reporting surface is a new capability, not an extension of an existing one, though it likely belongs
alongside the usage dashboard rather than as a fully separate feature.

## Decision

**1. Track machine-config runtime as its own dataset, decoupled from the $ spend cap entirely.**
Log machine-tier-change events (`{missionId, guestConfig, startedAt, endedAt}` — a segment per
tier the mission has run at) and surface them as a **new cockpit tab showing runtime (wall-clock
time, not dollars) per mission, broken down by time horizon (e.g. today / 7d / 30d / lifetime) and
by machine config** (which tier, how long). This is deliberately *not* merged into
`missionLifetimeCostUsd()` or the #49 spend-cap ceiling — LLM $ spend and machine runtime answer
different operator questions ("what am I being billed for LLM calls" vs. "how much compute time is
this mission actually using, at what tier"), and keeping them separate means the existing spend cap
keeps its current, already-understood meaning for every existing mission — no silent semantic
change to flag. The maintained Fly price table (see Context) is only ever a *display* convenience
here (an optional "~$X estimated" annotation on the runtime tab), never something enforcement
depends on being exactly correct. **This dataset is also ADR-0032's foundation** — its daily report
and VM-tier alert both read it.

**2. Two-step flow: a requesting agent asks via `PostMessage`; the mission-copilot decides and calls
the actual tool.** Step 1 needs no new capability — any agent uses its existing `PostMessage` tool:

```
PostMessage(to: ["mission-copilot"], subject: "Resource upgrade request",
  body: "Requesting performance-2x for ~3h to process a 10GB in-memory transform.")
```

Step 2 is the new Tier B tool, copilot-only, modeled on `SetMissionSpendCap`:

```ts
// mission-copilot-tools.ts, Tier B — copilot-exclusive, matching SetMissionSpendCap's own
// registration. The copilot fills requestedByAgentId from whichever agent asked (if any);
// omitted when the copilot is requesting for the mission's own general needs, not on
// behalf of a specific teammate.
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

Orchestration is the new execution-plane → control-plane route this signature implies: authenticated
exactly like the GitHub-proxy tools (see Context), performing the same stop →
`provisionMission(existingVolumeId, ...)` sequence `resumeMission()` already established. Unchanged
from before: this route doesn't need to know or care which agent originated the request, only that
the mission itself is who it claims to be.

**3. Suspend is hard and immediate — no idle-wait, no new safety orchestration.** Both the upgrade
itself and the eventual revert use the plain existing stop/recreate mechanism, with the exact same
interruption risk profile a manual operator suspend already has today (see Context). **The
mission-copilot is responsible for judging timing** — whether to act on a request now, ask the
requester to wait, or decline — via prompt/skill guidance, not a platform-enforced idle-wait. Unlike
the earlier direct-access design, the copilot is well-placed for this: it has (or can gather via its
own team-status awareness, `ReadMissionLog`, etc.) visibility across all of a mission's agents that
a single requesting agent lacks. **This guidance still can't live in ADR-0032's `resource-oversight`
skill** — that skill is provisioned only for the *control-plane* copilot (`provisionCopilotSkills`,
`copilot-daemon.ts`), a completely different agent from the *mission*-copilot this ADR is about.
The mission-copilot is an ordinary mission agent as far as skills go — `buildMissionCopilotAgentConfig`
(`mission-copilot.ts:319-368`) gives it a normal `AgentConfig` with `disabledSkills`, discovered via
the standard platform/team/mission/agent `discoverSkills()` tiering every other agent uses. The
right home for this guidance is either its own new platform skill under `packages/skills/`
(discoverable the normal way) or directly in `buildSystemPromptTemplate()`
(`mission-copilot.ts:39`), the function that already synthesizes the mission-copilot's system prompt
fresh each session — not a skill file shared with the unrelated control-plane copilot. Building a
live idle-wait mechanism instead (exporting a queryable "is this mission idle" signal, polling for
`runningJobs === 0`, bounding a wait with a timeout) was explored and rejected as unnecessary
complexity once the copilot itself is expected to manage timing (see Alternatives) — this was true
under both the direct-access and mediated designs, for slightly different reasons each time.

**4. Notifications, three distinct things, not two:**
- **Mission-cockpit visibility** — the request/renewal posts a mission-scoped audit message,
  mirroring `SetMissionSpendCap`'s `auditPost` mechanic, stamped `from: MISSION_COPILOT_AGENT_ID`
  (matching `SetMissionSpendCap`'s own pattern exactly, since only the copilot ever calls this tool
  now), `to: ["user"]` — visible in that mission's own Conversations panel. When `requestedByAgentId`
  is set, the audit body names that agent and its stated reason, so the operator sees who actually
  needed the upgrade, not just that the copilot acted.
- **Control-plane copilot informed, silently** — every request/renewal is recorded in Decision 1's
  own runtime dataset (or `missionAnomalies`) — no mailbox message, no wake, nothing displayed
  anywhere. This is the "control copilot should also be informed" requirement, satisfied as data the
  daily report reads (ADR-0032), not as a live event.
- **The mailbox-relay-to-`copilot-{userId}` mechanism is *not* used for the routine case at all** —
  reserved for a genuinely exceptional pattern (excessive renewals, prolonged upgraded-tier runtime),
  which is ADR-0032's concern, not this ADR's. See ADR-0032's Decision 4.

**5. The upgrade request automatically schedules its own renewal reminder, addressed to *both* the
mission-copilot and the requesting agent (if any)** — not left to either to remember unprompted.
`CreateScheduledMessage`'s underlying mechanism already supports exactly this: a one-off `deliverAt`
timestamp (not just recurring `cron`), delivered by the control plane's existing `scheduler.ts`
tick, addressed to `to: requestedByAgentId ? ["mission-copilot", requestedByAgentId] : ["mission-copilot"]`
— zero new plumbing (every agent, copilot included, is a normal entry in the runtime
`teamConfig.agents` array and picked up by the same unread-mail dispatch loop; `to` already accepts
multiple recipients). `RequestResourceUpgrade`'s own `execute()` inserts one `scheduled_messages`
document at `expiry − bufferMinutes` (default TBD, e.g. 10–15 min). On waking to that reminder,
**the mission-copilot decides whether to renew** — the same judgment-layer role it plays for the
original request (Decision 3) — but when `requestedByAgentId` is set, it first consults that agent
via ordinary `PostMessage` ("still need performance-2x? expiring in 10 min") rather than deciding
unilaterally, since the requesting agent is the one who actually knows whether its job is done. The
requesting agent gets the same reminder directly (not routed only through the copilot) so it isn't
silently blocked waiting on a copilot that's busy elsewhere — either can prompt the renewal
conversation. A renewal call cancels the pending reminder (same mechanic as `CancelScheduledMessage`
— `deleteOne({_id, missionId})`) and schedules a fresh one against the new expiry. This means
Decision 1's tracking record needs two more fields: `requestedByAgentId`, and the reminder's own
`scheduled_messages` `_id` so a renewal can find and replace it. The reminder is a courtesy nudge
only — if ignored, expiry still proceeds exactly as Decision 3 describes (hard, immediate revert);
this doesn't reopen the "wait for something before reverting" question already settled there.

**6. Extend `GetMissionStatus`** to include current machine tier (`memoryMb`/`cpus`/`cpu_kind`) and
how long the mission has been at that tier, so the control-plane copilot can answer a direct
question about it, and so ADR-0032's alerts and daily report have a single existing tool to read
from.

## Alternatives considered

- **Wait for the mission to be genuinely idle before resizing** (no in-flight agent dispatch, no
  unread mail, no running background job), rather than a hard immediate stop. Explored in detail —
  `runningAgents` is already queryable (`monitor-server.ts:1278`) but `runningJobs`
  (`daemon.ts:145`) is a private, unexported module-level variable, so this would need new plumbing.
  More importantly, it doesn't actually solve the motivating scenario: if an agent requests an
  upgrade *because* a computation is already running and straining memory, waiting for idle either
  waits for the very computation causing the problem (defeating the purpose) or the mission OOMs and
  crashes first, at which point the plain stop/recreate path was going to run anyway. Rejected in
  favor of Decision 3 — the mission-copilot manages timing itself, and the tool is documented as
  something to call *before* starting known-heavy work, not as a mid-crisis rescue.
- **Tier A direct access — any agent calls `RequestResourceUpgrade` itself, no mediation** (this
  ADR's immediately-preceding revision, shipped in `860401b` then reverted). Motivated by the real
  concern that agents themselves, not the mission-copilot, are the ones writing the large jobs that
  need more headroom — so requiring a round-trip through the copilot seemed like unneeded latency.
  Reverted after further consideration: a single requesting agent can't see what *other* agents on
  the mission are mid-task, so it has no way to judge whether an immediate hard-suspend is actually
  safe to trigger right now — only the mission-copilot has (or can gather) that cross-agent
  visibility. Direct access also meant every agent independently reasoning about renewal, expiry, and
  cost exposure with no single point of coordination, and no natural place to consult the
  mission-copilot before an extension the way the mediated flow's Decision 5 now does. The two-step
  flow costs one extra `PostMessage` round-trip (bounded by the requesting agent's next dispatch, not
  a synchronous wait) in exchange for a real judgment layer — accepted as the better trade.
- **Fully open-ended upgrade, no expiry at all.** Rejected: unbounded runtime-at-expensive-tier
  risk with no natural check-in point, and no mechanism to notice a forgotten upgrade. The renewal
  mechanic (Decision 3) is kept even though hard-suspend is now accepted as the interruption model,
  because it gives an explicit, audited checkpoint ("do I still need this") the requesting agent
  already has to reason about anyway when managing its own job timing around suspends.
- **Live-querying Fly for pricing.** Not available — no such API exists (verified: nothing under
  `flyctl platform`, no pricing fields in the Machines API). A maintained static table is the only
  option, with the acknowledged staleness risk that implies.
- **Folding machine runtime into `missionLifetimeCostUsd()` and the #49 spend-cap ceiling.**
  Rejected (this ADR's original direction, revised after review) — entangles two different signals
  (LLM $ spend vs. machine wall-clock time) and forces the maintained price table to be correct for
  *enforcement*, not just a display estimate. A runtime-by-tier report, decoupled entirely from the
  $ cap, is simpler and answers the actual operator question more directly.
- **Relaying every request/renewal to `copilot-{userId}` via `AnomalyRecorder`** (this ADR's
  original Decision 4). Rejected after confirming that doing so wouldn't actually cost anything
  visible (a relay doesn't auto-appear in the operator's chat — see Context) but also wouldn't
  *gain* anything for the routine case — it's needless wake traffic for something with no
  exceptional content. Reserved instead for ADR-0032's genuinely exceptional-pattern alert.

## Open questions

- **Default and maximum upgrade window length** — not designed yet; needs a concrete default
  (2 hours was used as an illustrative placeholder above, not a decision) and whether a maximum
  total upgraded duration should exist independent of renewal count.
- **Renewal-reminder buffer** (Decision 5) — how far before expiry the automatic reminder fires
  (10–15 min was illustrative, not decided); too short risks the requesting agent not getting a turn
  dispatched in time to act on it, too long makes it fire well before it would naturally reconsider.
- **Does the mission-copilot's timing-judgment guidance (Decision 3) need a dedicated platform
  skill, or is `buildSystemPromptTemplate()` enough?** Regular mission agents no longer need this
  guidance at all under the mediated design — they only ever call `PostMessage`, never the upgrade
  tool directly. The open question is narrower now: whether the mission-copilot's own guidance for
  judging request timing and renewal consultation belongs in a new platform skill (discoverable via
  the standard `discoverSkills()` tiering every mission agent uses, including the copilot) or is
  simple enough to embed directly in `buildSystemPromptTemplate()` (`mission-copilot.ts:39`). Either
  way, ADR-0032's `resource-oversight` skill is not the answer — it's provisioned only for the
  *control-plane* copilot via a separate mechanism (`provisionCopilotSkills`) and never reaches the
  mission-copilot. Not designed here, deliberately deferred until there's a first working version to
  observe.
- **Which tiers are selectable** — the full Fly catalog, or a curated subset (e.g. just
  performance-1x/2x/4x) to bound complexity and cost exposure per request.
- **Confirmation requirement — improved by the mediated design, not eliminated.** Because machine
  runtime is deliberately *not* folded into the $ spend cap (Decision 1), an unconfirmed upgrade
  request has **no dollar ceiling bounding it at all** — a materially different risk profile than
  `SetMissionSpendCap`, which at least answers to the #49 ceiling. Reverting to a Tier B,
  copilot-mediated tool narrows the exposure back down to a single trusted caller per mission (same
  trust assumption `SetMissionSpendCap` itself already carries, and #49's own incident was about that
  same copilot acting unilaterally) — but doesn't remove the underlying gap: the mission-copilot can
  still request/renew indefinitely with no operator confirmation and no dollar ceiling watching it.
  Decision 4 also keeps the routine case silent (mission-cockpit audit message + data logging only,
  no live relay to the control-plane copilot) — nothing short of ADR-0032's own exceptional-pattern
  alert would ever flag a mission stuck renewing an expensive tier indefinitely. Candidates: (a) a
  dedicated, operator-settable ceiling on cumulative upgraded-tier runtime or renewal count,
  mirroring the #49 ceiling pattern but denominated in time, not dollars — smaller lift than full
  `ProposeAction` infra (which no execution-plane agent has today, mission-copilot included — same
  gap CR-07/Sprint 28f tracks); (b) require confirmation on the *first* request only, not each
  renewal; (c) rely entirely on ADR-0032's exceptional-pattern alert as the only backstop, with no
  dedicated ceiling. Leaning toward (a) as the pragmatic default, but this needs a decision before
  implementation, not an assumption.
- **Rate-table maintenance process** — how staleness gets noticed (no automated signal exists);
  likely a periodic manual check against Fly's pricing docs. Lower stakes now that the table is
  display-only, not enforcement-critical.
- **New cockpit tab's exact shape** — per-mission drill-down, a cross-mission summary table, or
  both; likely worth designing alongside the existing "usage dashboard" backlog item (28f) rather
  than as a fully independent panel.

## Consequences

- New execution-plane → control-plane authenticated route — `docs/security/threat-model.md` gets a
  new entry when this is actually implemented (matches the existing GitHub-proxy TB-16 pattern, not
  a new trust-boundary shape).
- A new **Tier B** tool (`mission-copilot-tools.ts`), copilot-exclusive — same registration point as
  `SetMissionSpendCap`, `CreateScheduledMessage`/`CancelScheduledMessage`, and the GitHub-proxy
  tools. Regular mission agents get no new tool at all; they request an upgrade via their existing
  `PostMessage` capability, so this feature adds zero new surface to the Tier A array every agent
  already carries.
- No new orchestration for "safe" suspend timing — deliberately simpler than an earlier draft
  considered (see Alternatives); the mission-copilot's own judgment carries this responsibility
  instead, informed by whatever cross-agent visibility it can gather (team-status awareness,
  `ReadMissionLog`, etc.), which a single requesting agent lacks. Whether this guidance needs a
  dedicated new platform skill or belongs directly in `buildSystemPromptTemplate()` is still open
  (see Open Questions) — either way it's mission-copilot-only guidance now, not something that needs
  to reach every agent in the mission.
- A new data model for machine-tier-change segments (`{missionId, guestConfig, startedAt,
  endedAt}`) and a new cockpit tab to display it — genuinely new surface, not an extension of
  existing cost tracking. **Existing mission spend caps keep their current meaning unchanged** —
  this was a real risk in an earlier draft of this ADR and is now avoided by design.
- `GetMissionStatus`'s tool output grows by one field group (tier + duration-at-tier).
- No new scheduling infrastructure for the renewal reminder — reuses `CreateScheduledMessage`'s
  existing one-off `deliverAt` mechanism, multi-recipient `to`, and `scheduler.ts`'s existing
  delivery path unchanged; the only new code is `RequestResourceUpgrade` calling that same underlying
  write itself, addressed to both the mission-copilot and the requesting agent, instead of leaving
  either to remember unprompted.
- Any agent can still trigger a hard suspend indirectly, via a `PostMessage` the mission-copilot
  acts on — the mediation adds a judgment layer, not a hard gate; a copilot that acts on every
  request without pushback offers little more protection than direct access would have. This is the
  same trust assumption `SetMissionSpendCap` already carries, and is why the Confirmation-requirement
  open question above isn't closed by this design alone.

## Related

- `packages/control-plane/src/fly-machines.ts` — `provisionMission`/`resumeMission`, the
  stop-and-recreate-against-existing-volume pattern this feature reuses
- `packages/agent-runtime-worker/src/agent-runner.ts` (Tier A tool assembly, `disabledTools` filter,
  `getAdditionalTools`/Tier B split, `daemon.ts:721-724`'s `agentId === MISSION_COPILOT_AGENT_ID`
  wiring) — confirms `RequestResourceUpgrade` joins `mission-copilot-tools.ts`'s Tier B set exactly
  like every tool it's modeled on, not the Tier A array every agent gets by default
- `packages/agent-runtime-worker/src/monitor-routes/budget.ts`,
  `packages/agent-runtime-worker/src/mission-copilot-tools.ts` (`SetMissionSpendCap`,
  `CreateScheduledMessage`/`CancelScheduledMessage`) — Tier B, copilot-only tools whose registration
  point *and* mechanics this feature's tool, renewal step, and auto-reminder all mirror directly
- `packages/agent-runtime-worker/src/mission-copilot.ts` (`buildMissionCopilotAgentConfig`,
  `buildSystemPromptTemplate`, `injectMissionCopilot`) — confirms the mission-copilot is an ordinary
  runtime `teamConfig.agents[]` entry using the standard `discoverSkills()` tiering, and is the
  natural home for Decision 3's timing-judgment guidance (see Open Questions)
- `packages/control-plane/src/scheduler.ts` (`ScheduledMessageDoc`, `deliver()`) — the exact
  mechanism Decision 5's automatic renewal reminder reuses unchanged; confirmed a one-off
  `deliverAt` timestamp (not just `cron`) and a recipient other than `"mission-copilot"` both
  already work today with zero new plumbing
- `packages/agent-runtime-worker/src/anomaly.ts` (`AnomalyRecorder.record()`'s `missionAnomalies`
  vs. mailbox-relay split) — the precedent for "silent queryable data" this ADR's Decision 4 follows
  for the routine case; the `copilot-{userId}` mailbox-relay half is ADR-0032's concern, not reused
  here for routine requests/renewals
- `packages/control-plane/src/copilot-router.ts` (`GET /api/copilot/history`) — confirms a mailbox
  relay doesn't auto-appear in the operator's chat, the fact motivating Decision 4's simplification
- `packages/control-plane/src/missions.ts` (`/api/missions/stats`) and the Sprint 28f "usage
  dashboard" backlog item — closest existing precedent for the new runtime-reporting cockpit tab;
  `packages/agent-runtime-worker/src/limits.ts` (`missionLifetimeCostUsd`) is explicitly *not*
  touched by this feature, by design (Decision 1)
- `packages/control-plane/src/copilot-tools.ts` (`GetMissionStatus`) — to be extended with tier info
- [ADR-0032](0032-proactive-resource-oversight.md) — the control-plane copilot's proactive
  oversight capability, designed alongside this ADR and consuming its Decision-1 dataset
- Issue #31 (suspected OOM crash-loop) — likely closes, or is substantially reframed, once
  default/on-demand memory sizing exists
- ADR-0026 (sensitive-data encryption direction) — same "Proposed, research-recorded,
  implementation deferred" shape this ADR follows
