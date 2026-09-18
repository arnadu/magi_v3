# ADR-0032 — Proactive multi-resource oversight by the control-plane copilot

**Status**: Proposed — records a direction and the research behind it; several open questions
below need to be settled before implementation starts. Not yet assigned to a numbered sprint.
**Sprint**: TBD (candidate: same push as ADR-0031, right after 28f)
**Date**: 2026-09-18

**Related**: Split out from an earlier combined draft that also covered
[ADR-0031](0031-temporary-resource-upgrades-vm-cost.md) (temporary mission-machine resource
upgrades). The two are designed together — this ADR's VM-tier alert and daily report both read the
runtime dataset ADR-0031's Decision 1 produces — and likely ship in the same push, but are
genuinely separate concerns: ADR-0031 is about scaling *one mission's own machine* on request; this
ADR is about the control-plane copilot's *ongoing, cross-resource* monitoring of every mission a
user owns — VM tier, LLM cost, per-mission disk, and MongoDB Atlas storage, not just machine size.

---

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
control-plane copilot has no tool exposing it today — `GetMissionStatus` doesn't include spend.
VM tier is exactly what ADR-0031's Decision 1 dataset produces. Both just need a read path for the
control-plane copilot; neither needs new instrumentation.

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
  `ProposeAction` today, with **no new confirmation infrastructure needed for this ADR at all** —
  a real contrast with ADR-0031's mission-copilot upgrade tool, which has no such mechanism to lean
  on (see ADR-0031's Confirmation open question).

## Decision

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
spend, VM tier/runtime (ADR-0031's dataset), Fly Volume disk usage, and the shared Atlas storage
figure — and posts it as a single structured mailbox message, then ensures the copilot daemon is
running to read it.

**4. Add intra-day threshold alerts for all four resources**, reusing the *existing*
`AnomalyRecorder` → `copilot-{userId}` relay rather than inventing a second alerting mechanism: new
categories for disk-usage-high, atlas-storage-high, and prolonged-VM-upgrade (LLM cost already has
an equivalent path via the existing limit-breach category). Thresholds are operator-configurable,
default TBD (see Open Questions). **This ADR is the only user of this relay for VM-tier events** —
ADR-0031 deliberately does *not* relay every routine request/renewal (see its Decision 4); this
ADR's `prolonged-VM-upgrade` category is a periodic *pattern* check against ADR-0031's Decision-1
dataset (e.g. "renewed more than N times" or "cumulative upgraded-tier runtime exceeds X hours" for
one mission), not a live trigger fired on each request. It's the only thing standing in for a
dedicated cost/runtime ceiling on the upgrade mechanism itself — see ADR-0031's Confirmation open
question, which currently leans toward *also* wanting a hard ceiling rather than relying on this
alone.

**5. Drive the copilot's response through its existing conventions, not new ones**: extend
`config/teams/copilot.yaml`'s system prompt with a "Resource Oversight" responsibility section
(same structural pattern as the existing Anomaly-log guidance) describing what the daily report and
each alert category mean and what a reasonable response looks like; add a matching "Resource
Oversight" mental-map section (mirroring the existing Anomaly log) so the copilot has working
memory of what it's already flagged, avoiding duplicate operator pings on every wake; author a new
`resource-oversight` platform skill (reusing the already-working skill mechanism from Context)
bundling threshold reference info and response playbooks per resource type ("what to do when Atlas
storage is past 80%," "what to do when a mission has renewed its upgrade N times").

## Alternatives considered

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
- **Merging this into ADR-0031 as one document** (the original draft). Split out per review — the
  two are different shapes of work (a per-mission on-request mechanism vs. a cross-mission ongoing
  monitoring capability spanning resources ADR-0031 never touches) and read better, and are easier
  to reference independently, as separate ADRs even though they're likely implemented together.

## Open questions

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
- **Scope beyond the initial four resources** — the operator's own framing was "VM, LLM, disk,
  MongoDB usage, **etc.**"; this ADR designs for exactly four to keep the first delivery concrete,
  but the mechanism (Decision 1's wake-gap fix, Decision 3's daily report, Decision 4's alert reuse)
  is generic enough that adding a fifth resource later should be cheap. Worth confirming there's no
  other resource the operator already has in mind that should be included from the start rather
  than added later.

## Consequences

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
- No new confirmation-gate infrastructure needed for this ADR at all (see Context) — the
  control-plane copilot already has `ProposeAction` for anything mutating.

## Related

- [ADR-0031](0031-temporary-resource-upgrades-vm-cost.md) — the VM-tier runtime dataset this ADR's
  daily report and alert read; designed alongside this ADR, likely shipped together
- `packages/agent-runtime-worker/src/anomaly.ts`, `daemon-boot/mission-owner.ts` — the existing
  `copilot-{userId}` relay pipeline this ADR's alerts reuse (ADR-0020, F-028)
- `packages/control-plane/src/copilot-router.ts` (`ensureCopilotRunning`), `copilot-daemon.ts`
  (`provisionCopilotSkills`), `packages/control-plane/src/scheduler.ts` (`deliver()`) — this ADR's
  wake-gap fix and daily-report mechanism
- `packages/control-plane/src/copilot-tools.ts` (`GetMissionStatus`) — to be extended with tier info
  (shared with ADR-0031)
- `config/teams/copilot.yaml` — the existing Anomaly-log/ProposeAction conventions this ADR extends
  rather than replaces
- `docs/operational-resilience.md` — documents the real Atlas storage-quota incident motivating
  this ADR, and lists both G-4 (disk) and the Atlas-storage gap as still open
- Issue #31 (suspected OOM crash-loop) — likely closes, or is substantially reframed, once
  default/on-demand memory sizing (ADR-0031) and disk visibility (this ADR) both exist
- ADR-0026 (sensitive-data encryption direction) — same "Proposed, research-recorded,
  implementation deferred" shape this ADR follows
