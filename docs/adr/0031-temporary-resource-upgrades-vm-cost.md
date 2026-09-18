# ADR-0031 — Temporary mission-machine resource upgrades + proactive resource oversight

*(Filename kept as `0031-temporary-resource-upgrades-vm-cost.md` for link stability; the design
inside deliberately does not do $ cost accounting for machine time — see Part A, Decision 1.)*

**Status**: Proposed — records a direction and the research behind it; several open questions
below need to be settled before implementation starts. Not yet assigned to a numbered sprint.
**Sprint**: TBD (candidate: right after 28f, alongside or ahead of the Jupyter/webapp-exposure
feature — see MAGI_V3_ROADMAP.md)
**Date**: 2026-09-18

---

This ADR has two parts, sized and sequenced independently but designed together because Part B's
alerting reuses data Part A produces:

- **Part A** — let the mission-copilot request a temporary, bounded-window upgrade to a bigger Fly
  machine tier for genuine compute bursts, staying cheap by default the rest of the time.
- **Part B** — proactive, multi-resource oversight by the *control-plane* copilot: a daily report
  plus intra-day threshold alerts across VM tier, LLM cost, per-mission disk (Fly Volume), and
  MongoDB Atlas storage — driven by its existing system prompt/mental-map conventions and (newly
  written) skills, not new infrastructure for "the copilot can act on this."

---

# Part A — Temporary mission-machine resource upgrades

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

**The mission → owning-user's-control-plane-copilot relay pattern already exists and is reusable.**
`AnomalyRecorder.record()` (`anomaly.ts:51-137`) persists every anomaly to `missionAnomalies` and,
for `severity: "hard"` only, relays into that mission's owner's own `copilot-{userId}` mailbox —
which is exactly the mailbox the control-plane copilot's Change Stream watches (ADR-0020, the
F-028 fix). Every hard-severity category (agent crash/timeout, job failure, unclean restart,
scheduling failure, limit breach) already flows through this one pipe. A new "resource upgrade
requested/renewed" category can reuse this exact mechanism for free — no new infrastructure needed
to get the control-plane copilot (and, through its chat surface, the operator) informed of every
upgrade and renewal, which is the specific "control copilot should also be informed if we extend"
requirement.

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

## Decision (Part A)

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
depends on being exactly correct. **This dataset is also Part B's foundation** — the daily report
and the VM-tier alert both read it.

**2. A new mission-copilot tool requests a temporary upgrade for a bounded initial window**
(default TBD, e.g. 2 hours — see Open Questions), not an open-ended one. Orchestration requires a
new execution-plane → control-plane authenticated route (only the control plane holds
`FLY_API_TOKEN_MACHINES`) — the same trust pattern as the existing GitHub-proxy tools
(`mission-copilot-router.ts`'s `/api/mission-copilot/*`, monitor-token-authenticated, not
Firebase), not a new one. The route performs the stop → `provisionMission(existingVolumeId, ...)`
sequence already established by `resumeMission()`.

**3. Expiry reverts at the next safe boundary, never mid-computation.** This directly answers the
"a fixed timer might interrupt a computation" objection: rather than force-killing a running
Bash/compute subprocess when the window lapses, the upgraded tier persists until the mission's next
natural turn/dispatch boundary (or idle point), at which point it reverts to default unless renewed.
The mission-copilot must actively renew before expiry to keep the upgraded tier — mirroring
`/extend-budget`'s read-fresh-then-extend mechanic — rather than the control plane silently
extending it or the copilot needing to remember an open-ended commitment.

**4. Every request and renewal posts two notifications**, not one: the existing mission-level audit
mailbox message (matching `postLimitsAudit`'s pattern from #49), and a new hard-severity anomaly
category relayed through the *existing* `AnomalyRecorder` → `copilot-{userId}` pipeline — reusing
plumbing that already exists rather than building new scheduling infrastructure. This is what
answers "the control copilot should also be informed if we extend": it already will be, via the
same pipe that today carries crash/timeout/limit-breach alerts.

**5. Extend `GetMissionStatus`** to include current machine tier (`memoryMb`/`cpus`/`cpu_kind`) and
how long the mission has been at that tier, so the control-plane copilot can answer a direct
question about it, and so Part B's alerts and daily report have a single existing tool to read from.

## Alternatives considered (Part A)

- **Fixed auto-revert timer, no renewal.** Rejected per the operator's own objection: a hard
  timer can fire mid-computation and kill real work. The safe-boundary-revert-unless-renewed design
  (Decision 3) gets the same "doesn't run at the expensive tier forever unnoticed" property without
  that failure mode.
- **Fully open-ended upgrade, no expiry at all.** Rejected: unbounded runtime-at-expensive-tier
  risk with no natural check-in point, and no mechanism to notice a forgotten upgrade.
- **Live-querying Fly for pricing.** Not available — no such API exists (verified: nothing under
  `flyctl platform`, no pricing fields in the Machines API). A maintained static table is the only
  option, with the acknowledged staleness risk that implies.
- **Folding machine runtime into `missionLifetimeCostUsd()` and the #49 spend-cap ceiling.**
  Rejected (this ADR's original direction, revised after review) — entangles two different signals
  (LLM $ spend vs. machine wall-clock time) and forces the maintained price table to be correct for
  *enforcement*, not just a display estimate. A runtime-by-tier report, decoupled entirely from the
  $ cap, is simpler and answers the actual operator question more directly.

## Open questions (Part A)

- **Default and maximum upgrade window length** — not designed yet; needs a concrete default
  (2 hours was used as an illustrative placeholder above, not a decision) and whether a maximum
  total upgraded duration should exist independent of renewal count.
- **Which tiers are selectable** — the full Fly catalog, or a curated subset (e.g. just
  performance-1x/2x/4x) to bound complexity and cost exposure per request.
- **Confirmation requirement — now more open than before, not less.** Because machine runtime is
  deliberately *not* folded into the $ spend cap (Decision 1), an unconfirmed upgrade request has
  **no dollar ceiling bounding it at all** — a materially different risk profile than
  `SetMissionSpendCap`, which at least answers to the #49 ceiling. Candidates: (a) stay unconfirmed
  but add a dedicated, operator-settable ceiling on cumulative upgraded-tier runtime or renewal
  count, mirroring the #49 ceiling pattern but denominated in time, not dollars — smaller lift than
  full `ProposeAction` infra (which the mission-copilot doesn't have at all today — same gap
  CR-07/Sprint 28f tracks); (b) require confirmation on the *first* request only, not each renewal;
  (c) rely on the dual-notification visibility (Decision 4) alone, backstopped by Part B's own
  "prolonged upgrade" alert, and revisit if that proves insufficient in practice. Leaning toward (a)
  as the pragmatic default, but this needs a decision before implementation, not an assumption.
- **Rate-table maintenance process** — how staleness gets noticed (no automated signal exists);
  likely a periodic manual check against Fly's pricing docs. Lower stakes now that the table is
  display-only, not enforcement-critical.
- **New cockpit tab's exact shape** — per-mission drill-down, a cross-mission summary table, or
  both; likely worth designing alongside the existing "usage dashboard" backlog item (28f) rather
  than as a fully independent panel.

## Consequences (Part A)

- New execution-plane → control-plane authenticated route — `docs/security/threat-model.md` gets a
  new entry when this is actually implemented (matches the existing GitHub-proxy TB-16 pattern, not
  a new trust-boundary shape).
- A new `AnomalyCategory` and its relay wiring.
- A new data model for machine-tier-change segments (`{missionId, guestConfig, startedAt,
  endedAt}`) and a new cockpit tab to display it — genuinely new surface, not an extension of
  existing cost tracking. **Existing mission spend caps keep their current meaning unchanged** —
  this was a real risk in an earlier draft of this ADR and is now avoided by design.
- `GetMissionStatus`'s tool output grows by one field group (tier + duration-at-tier).

---

# Part B — Proactive multi-resource oversight (control-plane copilot)

## Context

**The control-plane copilot is purely reactive today**, not periodic. Its only wakeup mechanism is
a MongoDB Change Stream on the `mailbox` collection (`copilot-daemon.ts:204-429`); the daemon is
started lazily per-user only when a message arrives (`ensureCopilotRunning`, `copilot-router.ts:
109-122`, called from the `/message` route at `copilot-router.ts:160`). `node-cron`'s scheduler
(`scheduler.ts`) could in principle post to a copilot's own mailbox via the existing free-form
`create_schedule` `ProposeAction` type, but its `deliver()` function only wakes the *target* for
mission Fly machines — it explicitly checks machine state and calls `resumeMission()` before
inserting the mailbox message (`scheduler.ts:124-136`) — with no equivalent step for a
`copilot-{userId}` mailbox target. A scheduled message to a copilot today can land in its mailbox
without ever waking the daemon to read it. There is no existing "proactively review things on a
timer" capability for the control-plane copilot to build on; getting a genuine daily report
requires closing this gap, not routing around it.

**`ensureCopilotRunning` is structurally reusable but currently trapped.** It's a plain `async
function(userId: string)` with no HTTP/session dependency (`copilot-router.ts:109-122`), so a new
periodic timer calling it once per user is a small, mechanical addition in principle — but it, the
`runningDaemons` map, and `eventBus` are private closure variables inside `createCopilotRouter()`
(`copilot-router.ts:94-98`), which returns only the Express `router` (`:447`). Making it callable
from a new timer means either exporting these from `createCopilotRouter`, or extracting
daemon-management into its own module imported by both `copilot-router.ts` and the new timer.
Either is a real but small refactor. A `listUsers`-style query also doesn't exist yet
(`packages/control-plane/src/users.ts` has no such helper) and would need adding.

**Two of the four resources this ADR wants monitored have zero instrumentation today, not partial
implementations.** Confirmed by direct grep, not assumed:

- **MongoDB Atlas storage.** No `dbStats`, Atlas Admin API call, or storage-size query exists
  anywhere in the repo. This isn't a hypothetical risk — `docs/operational-resilience.md` documents
  a *real* incident: an Atlas M0 (512MB) quota outage that silently broke login. The fix at the time
  was purely reactive (delete old `llmCallLog` entries, lower `LOG_RETENTION_DAYS` twice, switch the
  pruner to `deleteMany`) — no ongoing usage monitoring was added, and `operational-resilience.md`
  still explicitly lists "no monitoring/alerting on Atlas storage" as open. This is the
  highest-justified item in this ADR's whole scope: it has already caused a production outage once.
- **Fly Volume disk usage (issue #31's sibling gap, G-4).** No disk-usage query, `statvfs`, or Fly
  Volume capacity API call exists anywhere. A precedent *does* exist for a different resource —
  `process.memoryUsage()` is already logged every 60s (added for issue #31's investigation) — but
  that's memory, not disk, and isn't surfaced anywhere an operator or copilot can see it; it's log
  lines only.

**LLM cost and VM tier already have data, just not a review surface for the control-plane copilot.**
LLM cost is fully tracked (`missionLifetimeCostUsd`, per-mission spend caps, ADR-0018) but the
control-plane copilot has no tool exposing it today — `GetMissionStatus` doesn't include spend (see
Part A's Context). VM tier is exactly what Part A's Decision 1 dataset produces. Both just need a
read path for the control-plane copilot; neither needs new instrumentation.

**The control-plane copilot already has everything needed to *act* on this — nothing new to build
for that half.** Verified directly, not assumed:
- **Skills already work for it.** `provisionCopilotSkills()` (`copilot-daemon.ts:143-198`) copies
  platform skills (`github-issues`, `objectives`, `incident-triage`) and team-specific skills
  (`config/teams/copilot/skills`) into the copilot's own `sharedDir/skills/_platform`
  (`copilot-daemon.ts:163,182-192`) — exactly the path `discoverSkills()` scans
  (`agent-runtime-worker/src/skills.ts:43`). The copilot's turns run through the same `runAgent()`
  path every mission agent uses (`copilot-daemon.ts:357`), so the full platform→team→mission→agent
  skill-tiering already applies. **"Specific skills to help it manage different kinds of
  situations" is authoring new skill files, not building new infrastructure.**
- **It already has a designed pattern for exactly this kind of ongoing tracking.** Its system
  prompt (`config/teams/copilot.yaml`) already instructs it to relay-triaged hard anomalies and
  "append a line to your mental map's Anomaly log" (`copilot.yaml:71`), with a dedicated `<h2>
  Anomaly log</h2>` section in its `initialMentalMap` (`copilot.yaml:118-125`) — a durable,
  persists-across-sessions scratchpad for "what I've already looked into and what I found." A
  "Resource Oversight" section following the identical convention is a natural, cheap extension —
  not a new mechanism, the same one used one section down.
- **It already has a standing confirmation rule that fits this cleanly.** `copilot.yaml:90-92`:
  "All mutating MAGI actions go through ProposeAction — never execute changes directly." Reporting,
  alerting, and messaging the operator are not mutating actions and need no new gate (same as its
  existing `PostMessage`/issue-tracking tools); if the design ever wants the control-plane copilot
  to *act* on a mission's resources directly (not just flag it), that already routes through
  `ProposeAction` today, with **no new confirmation infrastructure needed for Part B at all** —
  unlike Part A's mission-copilot tool, which has no such mechanism to lean on (see Part A's
  Confirmation open question).

## Decision (Part B)

**1. Close the scheduler → copilot wake gap first**, since the daily report depends on it: extract
`ensureCopilotRunning` (and the state it needs) out of `createCopilotRouter()`'s closure so both
`copilot-router.ts` and a new periodic job can call it, and add the missing wake step to
`scheduler.ts`'s `deliver()` for `copilot-{userId}` mailbox targets (mirroring the existing
`resumeMission()`-before-insert pattern it already has for mission Fly machines).

**2. Add instrumentation for the two untracked resources.** Fly Volume disk usage: logged in the
daemon's existing heartbeat (same cadence as the existing `process.memoryUsage()` logging added for
issue #31), reported to the control plane so it's queryable per mission — this is issue #31's
sibling gap G-4, done as a side effect of this work rather than separately. MongoDB Atlas storage:
a periodic `dbStats`-equivalent check run centrally by the control plane (this is a cluster-wide
resource, not a per-mission one — it doesn't belong on any single mission's daemon).

**3. Add a genuine daily report**, not just event-driven alerts: a new control-plane-side periodic
job (using the now-exported `ensureCopilotRunning` + a new `listUsers`-style query) that, once per
day per user, gathers that user's own missions' current state across all four resources — LLM
spend, VM tier/runtime (Part A's dataset), Fly Volume disk usage, and the shared Atlas storage
figure — and posts it as a single structured mailbox message, then ensures the copilot daemon is
running to read it.

**4. Add intra-day threshold alerts for all four resources**, reusing the *existing*
`AnomalyRecorder` → `copilot-{userId}` relay (the same pipe Part A's Decision 4 uses) rather than
inventing a second alerting mechanism: new categories for disk-usage-high, atlas-storage-high, and
prolonged-VM-upgrade (LLM cost already has an equivalent path via the existing limit-breach
category). Thresholds are operator-configurable, default TBD (see Open Questions).

**5. Drive the copilot's response through its existing conventions, not new ones**: extend
`config/teams/copilot.yaml`'s system prompt with a "Resource Oversight" responsibility section
(same structural pattern as the existing Anomaly-log guidance) describing what the daily report and
each alert category mean and what a reasonable response looks like; add a matching "Resource
Oversight" mental-map section (mirroring the existing Anomaly log) so the copilot has working
memory of what it's already flagged, avoiding duplicate operator pings on every wake; author a new
`resource-oversight` platform skill (reusing the already-working skill mechanism from Context)
bundling threshold reference info and response playbooks per resource type ("what to do when Atlas
storage is past 80%," "what to do when a mission has renewed its upgrade N times").

## Alternatives considered (Part B)

- **A new, from-scratch "objectives"-style structure for the control-plane copilot's own ongoing
  responsibilities** (mirroring the per-mission objectives tree). Rejected as unnecessary — the
  existing mental-map + Anomaly-log convention already solves exactly this problem for hard
  anomalies today, and extending that same pattern for resource oversight is materially cheaper
  than building or adapting a second structured-state mechanism just for this.
- **A dedicated new alerting pipeline for resource thresholds**, separate from `AnomalyRecorder`.
  Rejected — the existing pipe already reaches the right mailbox for the right user with no new
  code beyond adding categories; a second pipeline would be pure duplication.
- **Skipping Atlas storage monitoring as "already fixed"** (it did get a reactive fix once).
  Rejected — `operational-resilience.md` itself still lists this as an open gap, and the past
  incident is exactly the evidence that reactive-only handling isn't sufficient here.

## Open questions (Part B)

- **Threshold defaults per resource** — none proposed yet (disk %, Atlas storage %, "prolonged
  upgrade" duration/renewal count). Needs real numbers, likely informed by Atlas's actual tier
  limits (512MB on the current M0) and typical mission disk footprints.
- **Daily report format and delivery time** — per-user local time vs. a fixed UTC time; whether it
  should skip sending anything when nothing is noteworthy, or always send a short "all clear."
- **Where the Atlas `dbStats`-equivalent check actually runs** — inside `scheduler.ts`'s existing
  tick loop (reuses its already-running cadence) vs. a wholly separate timer; leaning toward the
  former to avoid a second periodic-job mechanism, but not decided.
- **Skill content ownership** — the `resource-oversight` skill's playbooks need real operational
  judgment (what's actually the right response to each situation), not just plumbing; this is
  writing, not engineering, and should happen with the operator's input, not assumed.

## Consequences (Part B)

- Two new pieces of instrumentation (Fly Volume disk usage in the daemon heartbeat; a centralized
  Atlas storage check) — both net-new monitoring, closing real, previously-flagged gaps (G-4 and
  the Atlas-storage gap from `operational-resilience.md`) as part of this work rather than
  separately.
- A small refactor to `copilot-router.ts` (exporting `ensureCopilotRunning`/daemon-management
  state) and one added branch in `scheduler.ts`'s `deliver()`.
- Three new `AnomalyCategory` values, reusing existing relay wiring.
- A new periodic control-plane job (daily report) and a new `listUsers`-style query.
- `config/teams/copilot.yaml`'s system prompt and `initialMentalMap` grow by one section each; one
  new platform skill (`resource-oversight`) — content work, not just code.
- No new confirmation-gate infrastructure needed for the control-plane copilot's half of this (see
  Context) — it already has `ProposeAction` for anything mutating.

## Related

- `packages/control-plane/src/fly-machines.ts` — `provisionMission`/`resumeMission`, the
  stop-and-recreate-against-existing-volume pattern Part A's upgrade mechanism reuses
- `packages/agent-runtime-worker/src/monitor-routes/budget.ts`,
  `packages/agent-runtime-worker/src/mission-copilot-tools.ts` (`SetMissionSpendCap`) — the
  renew/extend mechanic Part A's renewal step mirrors
- `packages/agent-runtime-worker/src/anomaly.ts`, `daemon-boot/mission-owner.ts` — the existing
  `copilot-{userId}` relay pipeline both parts' notifications reuse (ADR-0020, F-028)
- `packages/control-plane/src/missions.ts` (`/api/missions/stats`) and the Sprint 28f "usage
  dashboard" backlog item — closest existing precedent for Part A's new runtime-reporting cockpit
  tab; `packages/agent-runtime-worker/src/limits.ts` (`missionLifetimeCostUsd`) is explicitly *not*
  touched by Part A, by design (Decision 1)
- `packages/control-plane/src/copilot-tools.ts` (`GetMissionStatus`) — to be extended with tier info
- `packages/control-plane/src/copilot-router.ts` (`ensureCopilotRunning`), `copilot-daemon.ts`
  (`provisionCopilotSkills`), `packages/control-plane/src/scheduler.ts` (`deliver()`) — Part B's
  wake-gap fix and daily-report mechanism
- `config/teams/copilot.yaml` — the existing Anomaly-log/ProposeAction conventions Part B extends
  rather than replaces
- `docs/operational-resilience.md` — documents the real Atlas storage-quota incident motivating
  Part B, and lists both G-4 (disk) and the Atlas-storage gap as still open
- Issue #31 (suspected OOM crash-loop) — likely closes, or is substantially reframed, once
  default/on-demand memory sizing (Part A) and disk visibility (Part B) both exist
- ADR-0026 (sensitive-data encryption direction) — same "Proposed, research-recorded,
  implementation deferred" shape this ADR follows
