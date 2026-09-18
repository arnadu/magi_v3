# ADR-0031 — Temporary mission-machine resource upgrades + VM cost accounting

**Status**: Proposed — records a direction and the research behind it; several open questions
below need to be settled before implementation starts. Not yet assigned to a numbered sprint.
**Sprint**: TBD (candidate: right after 28f, alongside or ahead of the Jupyter/webapp-exposure
feature — see MAGI_V3_ROADMAP.md)
**Date**: 2026-09-18

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

**Cost tracking today is LLM-only.** Verified directly: `computeCost()`
(`agent-runtime-worker/src/llm-call-log.ts:160-183`) derives cost purely from token counts;
`MissionStats` (`agent-stats.ts:111-123`) has no machine-cost field; `missionLifetimeCostUsd()`
(`limits.ts:289-296`) sums only LLM cost; `fly-machines.ts` has no cost-related fields at all. **This
means the mission-wide spend cap (and its #49/F-025 ceiling) currently cannot see or bound VM
compute cost at all** — an important correction to an earlier assumption in this design
conversation that the existing cap already contained the financial risk of a resource upgrade. It
doesn't, as implemented today. VM cost accounting is therefore a prerequisite of this feature, not
an optional nice-to-have alongside it.

**The control-plane copilot is purely reactive today**, not periodic. Its only wakeup mechanism is
a MongoDB Change Stream on the `mailbox` collection (`copilot-daemon.ts:204-429`); the daemon is
started lazily per-user only when a message arrives. `node-cron`'s scheduler (`scheduler.ts`) could
in principle post to a copilot's own mailbox via the existing free-form `create_schedule`
`ProposeAction` type, but it does not start the copilot daemon if it isn't already running — so
this is not a designed, wake-guaranteeing mechanism. There is no existing "proactively review
things on a timer" capability for the control-plane copilot to build on.

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
the operator-set ceiling from #49 — the same trust tier this ADR proposes for resource-upgrade
requests, now that VM cost will actually count against that ceiling (see Decision).

## Decision

**1. Add VM cost accounting**, as a prerequisite, not a follow-on. Log machine-tier changes
(`{missionId, guestConfig, startedAt}`); compute cost from wall-clock duration at each tier × a
maintained static rate table (sourced from Fly's published pricing, refreshed manually — there is
no live pricing API to refresh it from automatically). Fold this into `missionLifetimeCostUsd()` so
the existing mission-wide spend cap and its #49 ceiling reflect **total** cost (LLM + compute), not
just LLM. This changes what an already-configured spend cap effectively means for existing
missions — worth flagging to the operator explicitly when this ships, not a silent semantic change.

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
question about it — and, combined with (4)'s alerts, has something concrete to react to.

**6. Proactive rightsizing review ("is this mission overprovisioned") is explicitly *not* solved by
this ADR** — it's a distinct, ongoing governance capability that needs the cost data from (1) to
exist before it can be meaningful, and very likely needs the periodic self-wake mechanism the
control-plane copilot doesn't have today (see Open Questions). Reactive alerting via (4) is the
near-term answer to "keep an eye on the VMs"; a genuine periodic report is deferred.

## Alternatives considered

- **Fixed auto-revert timer, no renewal.** Rejected per the operator's own objection: a hard
  timer can fire mid-computation and kill real work. The safe-boundary-revert-unless-renewed design
  (Decision 3) gets the same cost-bounding property without that failure mode.
- **Fully open-ended upgrade, no expiry at all.** Rejected: unbounded cost risk with no natural
  check-in point, and no mechanism to notice a forgotten upgrade.
- **A new periodic cron self-wake for the control-plane copilot**, to satisfy the "regular report"
  half of the request directly. Deferred, not rejected outright — real new infrastructure the
  control-plane copilot doesn't have today (see Context), and the reactive alert path (Decision 4)
  covers the acute "tell me when something happens" need without it. Revisit if reactive alerts
  prove insufficient for genuine proactive rightsizing (Decision 6).
- **Live-querying Fly for pricing.** Not available — no such API exists (verified: nothing under
  `flyctl platform`, no pricing fields in the Machines API). A maintained static table is the only
  option, with the acknowledged staleness risk that implies.

## Open questions

- **Default and maximum upgrade window length** — not designed yet; needs a concrete default
  (2 hours was used as an illustrative placeholder above, not a decision) and whether a maximum
  total upgraded duration should exist independent of renewal count.
- **Which tiers are selectable** — the full Fly catalog, or a curated subset (e.g. just
  performance-1x/2x/4x) to bound complexity and cost exposure per request.
- **Confirmation requirement.** Now that VM cost genuinely counts against the spend cap (Decision
  1), should requesting an upgrade require `ProposeAction`-style confirmation, or stay unconfirmed
  like `SetMissionSpendCap` (bounded only by the existing ceiling)? The mission-copilot has no
  `ProposeAction`-equivalent today (same gap CR-07/Sprint 28f tracks) — building one just for this
  feature would be scope creep; staying unconfirmed-but-capped is the pragmatic default unless a
  reason emerges to prioritize CR-07 sooner.
- **Rate-table maintenance process** — how staleness gets noticed (no automated signal exists);
  likely a periodic manual check against Fly's pricing docs.
- **Proactive periodic rightsizing review** (Decision 6) — needs its own design pass once VM cost
  data exists and once/if the control-plane copilot gets a genuine periodic self-wake mechanism.

## Consequences

- New execution-plane → control-plane authenticated route — `docs/security/threat-model.md` gets a
  new entry when this is actually implemented (matches the existing GitHub-proxy TB-16 pattern, not
  a new trust-boundary shape).
- A new `AnomalyCategory` and its relay wiring.
- **Existing mission spend caps change meaning** once VM cost counts toward them — an operator who
  set a cap under the old LLM-only assumption may find it binds sooner than expected. Needs
  explicit callout in release notes / the cockpit, not a silent behavior change.
- `GetMissionStatus`'s tool output grows by one field group (tier + duration-at-tier).
- Sized as its own sprint, not folded into 28f — different shape of work (new orchestration route,
  new cost-accounting subsystem) than 28f's operational-hardening items.

## Related

- `packages/control-plane/src/fly-machines.ts` — `provisionMission`/`resumeMission`, the
  stop-and-recreate-against-existing-volume pattern this feature reuses
- `packages/agent-runtime-worker/src/monitor-routes/budget.ts`,
  `packages/agent-runtime-worker/src/mission-copilot-tools.ts` (`SetMissionSpendCap`) — the
  renew/extend mechanic this feature's renewal step mirrors
- `packages/agent-runtime-worker/src/anomaly.ts`, `daemon-boot/mission-owner.ts` — the existing
  `copilot-{userId}` relay pipeline this feature's notifications reuse (ADR-0020, F-028)
- `packages/agent-runtime-worker/src/limits.ts` (`missionLifetimeCostUsd`),
  `packages/agent-runtime-worker/src/agent-stats.ts` (`MissionStats`) — where VM cost accounting
  needs to be folded in
- `packages/control-plane/src/copilot-tools.ts` (`GetMissionStatus`) — to be extended with tier info
- Issue #31 (suspected OOM crash-loop) — likely closes, or is substantially reframed, once
  default/on-demand memory sizing exists
- ADR-0026 (sensitive-data encryption direction) — same "Proposed, research-recorded,
  implementation deferred" shape this ADR follows
