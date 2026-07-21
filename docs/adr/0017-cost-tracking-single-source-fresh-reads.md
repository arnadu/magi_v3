# ADR-0017 — Cost tracking: single source of truth, always read fresh (no verification cache)

**Status**: Accepted
**Sprint**: 26b
**Date**: 2026-07-21

---

## Context

Sprint 24 (ADR-adjacent design notes in `MAGI_V3_ROADMAP.md`, "Agent Alignment and Efficiency —
Design Notes") set out an explicit goal for cost tracking: a **single source of truth and
computation of cost metrics**, and separately a **single verification of these cost metrics
against a set of limits**. What actually shipped in Sprint 24/25 had four independent
cost-tracking paths instead:

1. `llmCallLog` — MongoDB, one document per LLM call, unconditional, written for every call
   including reflection. The genuine raw source of truth.
2. `agentTurnStats` / `missionStats` (`agent-stats.ts`, `StatsCollector`) — MongoDB, incremental
   per-turn stats and `$inc`-updated lifetime totals. Correct, but reflection calls were excluded
   (no active turn to attribute them to — see Consequences below).
3. `UsageAccumulator` (`usage.ts`) — **in-memory only**, zero MongoDB hydration. Used for the
   mission-wide spend cap, the dashboard's `missionTotalUsd`, and the SSE `llm-call` ticker.
4. Objectives cost-attribution — derived from (2), with its own staleness/carry-over fallbacks.

The bug this ADR fixes was found live via the newly-shipped cockpit Limits panel: a real,
long-running mission (`gold-digest-v2-20260628-1451`) showed "Mission spend cap $7.52 / $60.00"
while its true persisted lifetime cost (`missionStats.lifetimeCostUsd` summed across agents) was
$60.26. Root cause: `UsageAccumulator` is constructed fresh on every daemon process start with no
read from MongoDB — every prior session's spend is invisible to it until the process
accumulates new calls of its own. The mission-wide cap check and the dashboard total were both
sourced from this object.

A second, independent gap was found during the same audit: reflection LLM calls (which run
outside the normal turn lifecycle — before `startTurn`, since there's no active turn to attribute
them to yet) were excluded from `missionStats` by design. This meant even the *correct*,
MongoDB-persisted path under-counted real spend by cumulative reflection cost.

---

## Decision

### Single source of truth: `missionStats`, read fresh at every verification

Every place a cost figure is checked against a limit — the mission-wide spend cap, the per-agent
`maxLifetimeCostUsd` hard limit, and turn cost-attribution into the objectives store — now reads
`missionStats` **fresh from MongoDB at the moment of the check**, via two new `StatsCollector`
methods:

```
StatsCollector.readLifetime(missionId, agentId): Promise<MissionStats | null>
  — thin wrapper on the existing repo.loadMission(), explicitly named so every
    call site visibly declares "this is an uncached read."

StatsCollector.readMissionSnapshot(missionId): Promise<Array<{agentId, lifetimeCostUsd, turnCostUsd}>>
  — combines every agent's persisted missionStats.lifetimeCostUsd with any
    currently in-flight (status:"running") agentTurnStats.costUsd, for the
    mission-wide total.
```

`StatsCollector`'s in-memory `lifetimes: Map<string, MissionStats>` cache — which existed
specifically so `startTurn()` wouldn't need to hit MongoDB on every turn — is **removed
entirely**. There is no cached lifetime value left in the process to be correct or stale.

`limits.ts` gained one new pure function, `missionLifetimeCostUsd(snapshot)`, which sums
`lifetimeCostUsd + turnCostUsd` across the snapshot. This mirrors the shape `metricValue()`
already used for the existing per-agent `"lifetimeCostUsd"` case (`(lifetime?.lifetimeCostUsd ??
0) + turn.costUsd` — persisted total plus this-turn-so-far, so a cap can trip mid-turn) — the
mission-wide version is the same pattern extended across agents rather than a new concept.
`limits.ts` remains pure/no-I/O; only the caller now obtains its input from a fresh read instead
of a cache.

### Why not fix the cache instead of removing it?

Two earlier drafts were built and rejected before this design, both making the same mistake in
different ways:

- **Draft 1**: hydrate `UsageAccumulator` from `missionStats` at daemon boot, keep using it as the
  cap/display source. Rejected — this preserves a second, uncoordinated copy of the truth instead
  of eliminating it; any future write path that forgets to update both stays a live bug.
- **Draft 2**: extend `StatsCollector` with a *better*-hydrated in-memory lifetime cache
  (`hydrateRoster()`/`costSnapshot()`, reloaded at boot and kept in sync incrementally).
  Rejected on the same principle one level up: **any** in-memory cache of verification-critical
  data can drift from what's actually persisted — that drift is precisely the bug class that
  produced the $7.52-vs-$60.26 gap in the first place. A better-hydrated cache is still a cache.

The design that shipped removes the cache instead of improving it. The deciding argument: an LLM
call takes seconds; an indexed MongoDB `find`/`findOne` takes low single-digit milliseconds. There
is no real performance case for caching data whose staleness has direct dollar consequences, and
the correctness gained by never trusting a cache for this purpose is worth far more than the
round-trip saved. This principle was confirmed to apply uniformly — the already-numerically-correct
per-agent `maxLifetimeCostUsd` check was converted to the same fresh-read pattern too, not left on
its old cache just because it happened not to be the check that was visibly broken.

### What stays cached (and why that's fine)

- **`StatsCollector.turns`** (the per-turn write-staging `Map` behind the incremental
  `agentTurnStats` upsert) is unaffected. It is not a cache of anything durable — it's exactly as
  fresh as the turn currently in flight, and a daemon restart naturally starts a new turn anyway,
  so there is no "stale after restart" failure mode here.
- **`UsageAccumulator`** is kept, unchanged in code, but its header comment now states explicitly
  that it is session-only console/SSE-ticker telemetry — never a source for any dollar figure an
  operator relies on or a limit is checked against. It still drives the per-call console log line
  (`callLine()`) and the SSE `llm-call` event's live ticker fields, both purely cosmetic: nothing
  makes a decision from them, and being momentarily wrong until the next real call arrives is
  harmless for a live-updating ticker in a way it is not for a budget gate.

### Reflection cost gap

Closed via a new `StatsCollector.recordReflectionCost(missionId, agentId, costUsd)`, which calls a
new, leaner repository method `incrementLifetimeCostOnly()` — unlike `incrementMission()`, it does
not touch `lifetimeTurnCount` or `consecutiveZeroOutputTurns`, since a reflection call is not a
turn. `agent-runner.ts`'s `makeOnLlmCall` now routes reflection calls here instead of silently
dropping their cost from `missionStats` (they were always recorded in `llmCallLog`; they just
never reached the lifetime total).

### New failure mode, closed in the same pass

Converting these paths from pure in-memory reads (which could never throw) to MongoDB reads
(which can, on a transient connection blip) introduces a new way a hot-path call could fail:
`agent-runner.ts`'s `enforceLimits` (checked after every tool result and every LLM call) and
`daemon.ts`'s per-message mission-cap check both now await a MongoDB read. An uncaught failure
there would crash an agent's turn on a one-off Mongo hiccup — which the codebase's own standing
principle ("statistics must not break a mission," already applied to every *write* path in
`agent-stats.ts`) rules out for a read too. Both call sites now fail open: log the error and skip
that one check. The same check re-runs on the very next LLM call or tool result, so a transient
failure self-heals rather than aborting a turn or blocking a mission.

---

## Consequences

- **Reintroduces a MongoDB read into a path Sprint 24 deliberately kept DB-free** (every LLM call,
  every tool result). Accepted deliberately — see the performance argument above. No caching is
  reintroduced to claw back the round-trip; that would recreate exactly the bug this ADR fixes.
- **`OrchestratorConfig.onAgentMessage`** widened from `(agentId, msg) => void` to
  `=> void | Promise<void>`, and the orchestrator's internal wrapper now actually `await`s it —
  needed so `daemon.ts`'s mission-wide cap check is guaranteed to complete against this call's
  data before the inner loop dispatches its next LLM call. Backward-compatible: every existing
  caller already passes a synchronous callback, which still satisfies the widened type.
- **`MonitorServer`** gained a `statsCollector` constructor parameter (two integration test call
  sites updated). `statusPayload()` (8 call sites) and `POST /set-budget`'s pause/resume decision
  both became `async` and now read the fresh mission snapshot instead of
  `this.accumulator.totalCostUsd()`. `/set-budget`'s case is safety-critical — it decides whether a
  paused mission resumes — so it was fixed regardless of how rarely that route is called.
- **Restart-durability is now structural, not procedural.** Previously, correctness after a daemon
  restart depended on remembering to reload a cache at the right point (`startTurn`'s "load if not
  cached" logic). Now there is nothing to reload — every check is already reading the current
  persisted state, restart or not. This closes the `waitForBudget`-related gap noted in
  `docs/operational-resilience.md` Layer 4.
- **Verification performed**: 265 unit tests (including a rewritten `agent-stats.unit.test.ts` —
  the old "reloads lifetime totals from the repo after a restart" test asserted the now-removed
  `getLifetime()`); a new integration test exercises `readMissionSnapshot`/
  `incrementLifetimeCostOnly` against real MongoDB with two independent `StatsCollector` instances
  (simulating two daemon processes) to directly demonstrate there is no cache to be out of sync;
  full existing integration suite re-run green including a live reflection LLM call
  (`reflection.integration.test.ts`) and a live multi-agent run; `readMissionSnapshot()` was run
  directly against the real Gold Digest V2 mission's data and matched a raw `missionStats`
  aggregation exactly.
- **Not yet verified live**: the actual daemon-restart scenario against a running mission needs an
  execution-plane image rebuild and that mission's machine cycling onto the new image before the
  fix can be observed directly in production, rather than only proven correct by the test suite.

---

## Related

- `MAGI_V3_ROADMAP.md` — "Agent Alignment and Efficiency — Design Notes" (the original Sprint 24
  single-source-of-truth intent this ADR restores)
- `docs/operational-resilience.md` — Layer 4 (`waitForBudget`), Layer 6 (statistics read/write
  failure modes), "Recently fixed" table
- `docs/implementation-history.md` — Sprint 26b "Cost-tracking correctness rewrite" section (full
  narrative, including the two rejected drafts)
- `packages/agent-runtime-worker/src/agent-stats.ts` — `StatsCollector`, header comment states this
  ADR's principle directly
- `packages/agent-runtime-worker/src/limits.ts` — `missionLifetimeCostUsd()`
- `packages/agent-runtime-worker/src/usage.ts` — `UsageAccumulator`, demoted via header comment
