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
question about it, and so ADR-0032's alerts and daily report have a single existing tool to read
from.

## Alternatives considered

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

## Open questions

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
  (c) rely on the dual-notification visibility (Decision 4) alone, backstopped by ADR-0032's own
  "prolonged upgrade" alert, and revisit if that proves insufficient in practice. Leaning toward (a)
  as the pragmatic default, but this needs a decision before implementation, not an assumption.
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
- A new `AnomalyCategory` and its relay wiring.
- A new data model for machine-tier-change segments (`{missionId, guestConfig, startedAt,
  endedAt}`) and a new cockpit tab to display it — genuinely new surface, not an extension of
  existing cost tracking. **Existing mission spend caps keep their current meaning unchanged** —
  this was a real risk in an earlier draft of this ADR and is now avoided by design.
- `GetMissionStatus`'s tool output grows by one field group (tier + duration-at-tier).

## Related

- `packages/control-plane/src/fly-machines.ts` — `provisionMission`/`resumeMission`, the
  stop-and-recreate-against-existing-volume pattern this feature reuses
- `packages/agent-runtime-worker/src/monitor-routes/budget.ts`,
  `packages/agent-runtime-worker/src/mission-copilot-tools.ts` (`SetMissionSpendCap`) — the
  renew/extend mechanic this feature's renewal step mirrors
- `packages/agent-runtime-worker/src/anomaly.ts`, `daemon-boot/mission-owner.ts` — the existing
  `copilot-{userId}` relay pipeline this feature's notifications reuse (ADR-0020, F-028)
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
