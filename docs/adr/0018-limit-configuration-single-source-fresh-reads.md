# ADR-0018 — Limit configuration: single source of truth, read fresh (extends ADR-0017)

**Status**: Accepted
**Sprint**: 26b
**Date**: 2026-07-21

---

## Context

ADR-0017 fixed cost *metrics* (the measured numbers — `missionStats`, `agentTurnStats`) to always
read fresh from MongoDB instead of trusting an in-memory cache. It deliberately left limit
*configuration* (the thresholds themselves — `agent.limits`, `mission.maxCostUsd`) untouched.

Asked directly whether the mission copilot's claim that "a limit change requires a suspend/resume"
was true, the honest answer split in two: the mission-wide cap mostly escapes this via a bolted-on
push mechanism (`writeMissionCap`, control-plane, best-effort calls the running mission's `POST
/set-budget`, which mutates `MonitorServer.currentCapUsd` and pushes that value back into
`daemon.ts` via an `onBudgetExtended` callback), while per-agent limits have no such mechanism at
all — a cockpit edit to `agent.limits` only takes effect on the mission's next resume, because
`daemon.ts` loads `teamConfig` once at boot (`loadTeamConfig()`) and every agent's `LimitRule[]` is
built once per turn from that frozen snapshot (`agent-runner.ts`, `buildRules(agent.limits)`).

This is the identical architecture smell ADR-0017 removed for cost metrics — an in-memory value
that can diverge from the persisted config, papered over with a manual sync callback instead of
being read fresh. Pointed out directly: "I thought we had agreed on a single place for all the
computations" — the earlier fix only covered half of what "computations" means here; the
*measured* half was fixed, the *configured* half was not.

**A further gap was found while designing this fix, in scope for the same change:** the mission
copilot's `SetMissionSpendCap` tool calls `POST /set-budget` directly, and that route **never wrote
to MongoDB at all** — it only mutated `MonitorServer.currentCapUsd`. A copilot-set cap was invisible
to any Mongo-based read (the cockpit, a restart) and silently lost the moment the daemon restarted.
The same was true of the legacy non-cockpit dashboard's `/extend-budget` button (`public/app.js`,
still reachable). Both needed to actually persist before the read side could safely trust MongoDB
as the only source of truth — otherwise moving the read side to Mongo-only would have been a
regression for these two write paths.

---

## Decision

### One new small repository, mirroring `AgentStatsRepository`

New `packages/agent-runtime-worker/src/mission-config.ts`:

```ts
interface MissionConfigRepository {
  readTeamConfig(missionId: string): Promise<TeamConfig | null>;
  writeMissionCap(missionId: string, maxCostUsd: number): Promise<void>;
}
```

`readTeamConfig` does exactly what `daemon.ts` already does for team files —
`db.collection("missions").findOne({missionId}, {projection: {teamConfigYaml: 1}})` — then
`parseTeamConfig()` (existing, `@magi/agent-config`) the YAML text. `teamConfigYaml` is a small
text blob (agent definitions + the mission node; `teamFiles` is a separate top-level field), so a
full parse-and-validate per call is cheap relative to LLM call latency — unlike cost metrics, there
is no need for a denormalized fast-read aggregate here (that's what `missionStats` earns by
aggregating a genuinely large, ever-growing `llmCallLog`; `teamConfigYaml` has no such growth
problem). `writeMissionCap` reuses `patchMissionCap` + `parseTeamConfig` from `@magi/agent-config`
— the same primitives `packages/control-plane/src/missions.ts`'s `writeMissionCap` already uses —
find doc, patch YAML, validate, `updateOne`.

### Per-agent limits: read fresh, fall back to the boot-time snapshot on failure

`enforceLimits` (`agent-runner.ts`) moved its `buildRules()` call from once-per-turn (outside the
async closure, built from the static `agent.limits`) to inside the closure, re-fetched on every
check:

```ts
let liveLimits = agent.limits ?? {};                 // boot-time snapshot: the fallback
try {
  const live = await ctx.missionConfig?.readTeamConfig(missionId);
  const liveAgent = live?.agents.find((a) => a.id === agentId);
  if (liveAgent) liveLimits = liveAgent.limits ?? {};
} catch (e) { /* log, fall back to snapshot */ }
const rules = buildRules(liveLimits);
```

Unlike the cost-metric fix (where a failed read is skipped — no safe non-zero fallback exists for a
dollar figure), a strictly better fallback is available here for free: the boot-time snapshot
already sitting in `ctx.teamConfig`. A transient Mongo hiccup degrades to "enforce yesterday's
limits for one check" rather than "enforce nothing."

### Mission cap: read fresh, boot-time value becomes the fallback only

`daemon.ts`'s `onAgentMessage` cap check now fetches `missionConfig.readTeamConfig(missionId)`
alongside the `readMissionSnapshot()` call ADR-0017 already added, using
`live?.mission.maxCostUsd ?? maxCostUsd` (live value if available, else the boot-time
config-or-env-var value resolved once at startup) as the effective cap. `onBudgetExtended` and the
push-sync into `daemon.ts`'s local `maxCostUsd` variable are removed — nothing needs to push into it
anymore, since the read side now pulls current state on every check regardless of who last wrote it.

### `/set-budget` and `/extend-budget` become the durable write path

Both routes previously only mutated `MonitorServer.currentCapUsd` — never touching Mongo. Fixed:
`/set-budget` calls `missionConfig.writeMissionCap()` before anything else (this closes the mission
copilot's Mongo-blind-spot gap, since `SetMissionSpendCap` calls this route directly);
`/extend-budget` reads the current persisted cap fresh, adds, and persists via the same method.
`currentCapUsd` as an instance field is removed entirely — `statusPayload()`'s `maxCostUsd` now
reads `missionConfig.readTeamConfig()` fresh, matching how `missionTotalUsd` already read fresh
under ADR-0017.

**Why `writeMissionCap`'s existing best-effort push from control-plane still matters, even though
the cap value no longer needs it to propagate:** `waitForBudget()` (`orchestrator.ts`) blocks the
dispatch loop entirely while a mission is paused — no further `onAgentMessage` fires to notice a
raised cap on its own while blocked. Calling `/set-budget` remains the only way to *wake* an
already-paused mission immediately; it's no longer the only way the cap *value* propagates to a
mission that isn't currently paused. This is a narrowing of the push's role, not a removal.

Per-agent limits need no equivalent push: a hard breach aborts a turn immediately rather than
entering a blocking wait state, and `enforceLimits` re-checks on literally the next tool result or
LLM call regardless — a pure fresh-read is sufficient.

### Not changed

- `packages/control-plane/src/missions.ts`'s `writeMissionCap`/`writeAgentLimits` — already correct
  (unconditional Mongo write, no suspend check).
- `limits.ts` stays pure/no-I/O — only callers change what they pass in, same principle as
  ADR-0017.

---

## Consequences

- **Another Mongo read added to the same hot path ADR-0017 already touched** (every LLM call, every
  tool result now reads both `missionStats` and `teamConfigYaml`). Accepted for the same reason:
  LLM/tool latency is seconds; two additional indexed reads are negligible in comparison, and this
  read now happens even for missions with no cap configured (to detect a cap added live) — a small,
  deliberate trade for correctness, consistent with the principle already established and endorsed.
- **A per-agent limits edit and a mission-cap edit now both take effect on the very next check, with
  no suspend/resume required** — closing the gap the mission copilot's own answer to "does this
  need a restart?" had gotten right for one case and wrong for the other.
- **The mission copilot's `SetMissionSpendCap` tool is now durable.** Previously a copilot-set cap
  vanished on daemon restart with no trace; now it persists exactly like a cockpit edit.
- **Verification performed**: full unit suite green (no existing tests needed changes — the fallback
  design means `ctx.missionConfig` absent behaves exactly like before). New integration coverage
  against real MongoDB: `mission-config.integration.test.ts` (repository read/write, including a
  second writer's edit becoming visible to a fresh read); `monitor-budget.integration.test.ts`
  (`/set-budget`/`/extend-budget` persist to `missions.teamConfigYaml`, `/status` reflects it,
  pause/resume still works). One end-to-end real-LLM test,
  `limits-live-config.integration.test.ts`, is the strongest proof: the boot-time `teamConfig` has
  no limits configured for the test agent at all, while the mission's persisted `teamConfigYaml` has
  `maxLlmCallsPerTurn: 1` — the turn aborted with exactly that hard-limit breach, which is only
  possible if the live read path is genuinely being used, not the boot-time snapshot.
- **Not yet verified live**: the actual "operator edits a limit on a running mission, sees it apply
  with no resume" scenario needs a live mission (Gold Digest V2, planned) and an execution-plane
  image rebuild — same two-step verification gap as ADR-0017.

---

## Related

- [ADR-0017](0017-cost-tracking-single-source-fresh-reads.md) — the cost-metrics half of this same
  principle; this ADR extends it to configuration
- `docs/implementation-history.md` — Sprint 26b narrative for both ADRs
- `packages/agent-runtime-worker/src/mission-config.ts` — `MissionConfigRepository`
- `packages/agent-runtime-worker/src/agent-runner.ts` — `enforceLimits`, live-limits-with-fallback
- `packages/agent-runtime-worker/src/daemon.ts` — mission cap check, fallback value
- `packages/agent-runtime-worker/src/monitor-server.ts` — `/set-budget`, `/extend-budget`,
  `statusPayload()`
