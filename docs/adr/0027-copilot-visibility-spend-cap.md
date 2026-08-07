# ADR-0027 — Control-plane copilot visibility: Transcripts, Files, spend-cap Limits

**Status**: Accepted
**Sprint**: 27
**Date**: 2026-08-07

---

## Context

The control-plane copilot (distinct from the per-mission "mission copilot", ADR-0016) runs as a
real agent — its own OS user (`magi-copilot`), a real workdir, and full LLM turns persisted via
`conversationRepo`/`llmCallLog` — but none of that was visible in the cockpit. `CopilotPanel.tsx`
only showed the live chat stream plus a one-line cost readout: no way to inspect what tools it
called on a given turn, browse its filesystem, or cap what it can spend. Asked directly for a way
to close that gap, following the exact per-mission patterns the cockpit already has (Transcripts,
Files, Limits) but scoped to the copilot's own data.

Two things were confirmed during investigation that shaped every decision below.

**`agentTurnStats`/`missionStats` were never written for the copilot.** `runAgent()` only records
turn/cost stats when the caller supplies `ctx.statsCollector` — `copilot-daemon.ts`'s
`AgentRunContext` construction never set it. `StatsCollector` itself needs nothing beyond a `Db`
handle (`new StatsCollector(createMongoAgentStatsRepository(db))`) — no `missions` collection
document, no team config — so wiring it in was a clean, zero-special-casing addition, and it's the
same instance-per-daemon-lifetime pattern the mission daemon already uses.

**The existing mission Transcripts/Limits routes (`/api/missions/:id/turns|transcript|llm-calls|
llm-call|limits`) 404 immediately** on an ownership `findOne` against the `missions` collection,
which has no document for `copilot-{userId}` (it isn't a mission). The query logic underneath is
trivial `(missionId, agentId[, turn])`-scoped Mongo reads with no other dependency on that
document, so it factored out cleanly into `transcript-queries.ts`, shared by both the mission
routes (unchanged behavior, ownership check stays in `missions.ts`) and new copilot routes (no
ownership lookup needed — the caller's `userId` is already baked into the derived missionId).

---

## Decision

### Reuse StatsCollector for a synthetic missionId

`copilot-daemon.ts`'s `runWatchLoop` now constructs one `StatsCollector` alongside its existing
`conversationRepo`/`llmCallLog`, and passes it into `AgentRunContext`. No `missions` document is
required anywhere in `StatsCollector`'s construction or read/write paths — every method is scoped
purely by `(missionId, agentId[, turnNumber])`. This gives the copilot the same `agentTurnStats`/
`missionStats` visibility every mission agent already has, for free, and unlocks two things at
once: the Transcripts turn timeline, and a lifetime-cost read for the spend cap (below). The
copilot's own `copilot.yaml` agent has no `limits:` block, so `enforceLimits` activates but finds
nothing configured — a harmless no-op unless someone adds one later.

### Extract the transcript queries once, reuse from two callers

New `packages/control-plane/src/transcript-queries.ts` exports `queryTurns`, `queryTranscript`,
`queryLlmCalls`, `queryLlmCall` — pure `(db, missionId, agentId[, turn[, i]])` functions with no
dependency on the `missions` collection. `missions.ts`'s four route handlers now call these
(pure refactor, ownership check unchanged); `copilot-router.ts`'s new `GET /turns|transcript|
llm-calls|llm-call` routes call the same functions with `missionId = "copilot-{userId}"`,
`agentId = "copilot"`, no ownership lookup — the userId is already the whole scope.

### Files: direct filesystem read, not a proxy

Every mission file route is proxied to that mission's execution-plane MonitorServer, because a
mission's files live on a separate Fly machine's volume. The control-plane copilot runs
**in-process in the control-plane container**, so its workdir (`COPILOT_WORKDIR`) is on the
control-plane's own local filesystem — no proxy needed. New `copilot-files.ts` ports
`monitor-server.ts`'s `serveFilePath` logic to a plain Express-friendly function
(`readCopilotFileNode`), with the same `resolve()`+`realpathSync()` symlink-safe boundary check
as the F-003 fix, returning the identical `DirEntry[]`/`FileNode` JSON shape the cockpit's
existing types already model — read-only (no write/edit, no git-history: the copilot workdir
isn't git-tracked the way mission `sharedDir`s are).

One known limitation, recorded rather than silently accepted: `COPILOT_WORKDIR` is one shared OS
identity (`magi-copilot`, TB-15) across every user's copilot, not per-user. The new Files route
therefore shows every user's copilot files to any authenticated user who opens it, not just their
own. Explicitly chosen not to fix now (per-user subdirectory scoping) — acceptable for the
current solo-operator deployment; revisit if the control-plane copilot becomes genuinely
multi-tenant. See threat-model.md TB-21.

### Spend cap: synchronous block-at-dispatch, not missions' async pause/waitForBudget

Missions enforce a spend cap by pausing the orchestration loop mid-flight
(`MonitorServer.notifyCostPause()` → `waitForBudget()` blocks the *next* dispatch until an
operator raises the cap) — appropriate there because the loop runs continuously across many
turns with no natural per-request boundary to gate on. The control-plane copilot has a much
simpler dispatch model: one HTTP request (`POST /message`) per user turn. So the cap check
(`checkCopilotSpendCap`, exported for testing) runs synchronously at the top of that handler,
before the message is even posted to the mailbox — reading `getCopilotSpendCap(db, userId)` and
current spend via the same `StatsCollector.readLifetime()` the Limits route uses, rejecting with
`402` if spend has reached the cap. An in-flight turn always finishes; only a *new* message is
blocked once over cap. This deliberately mirrors this file's own existing stance against
mid-turn aborts (the `/settings` model-switch route rejects an in-flight change for the same
reason — a prior incident there left a `tool_use` persisted with no result, permanently
corrupting the copilot's history) rather than inventing a new abort path.

Cap storage follows the existing per-user settings precedent exactly: `copilotSpendCapUsd?:
number` on `UserDoc` (`users.ts`), with `getCopilotSpendCap`/`setCopilotSpendCap` mirroring
`getCopilotModel`/`setCopilotModel`'s upsert-with-`$unset`-on-undefined pattern.

### Frontend: a new top-level "Copilot" nav entry, not an expanded chat panel

Two placements were considered: expanding the existing persistent chat side-panel with inline
sections, or a dedicated top-level view alongside Missions/Templates with its own tab set. Chose
the latter — it mirrors the existing per-mission dashboard's own Objectives/Files/Transcripts/
Limits tab structure, so the interaction pattern is already familiar, and it reuses the same
`tabs`/`tab`/`tab-body` CSS rather than inventing a new layout inside the narrow chat panel.
`CopilotPanel` (the chat itself) stays exactly where it is — visible regardless of which
`homeTab` is selected, same as `ConversationsPanel` staying visible across `mainTab` switches in
a mission dashboard.

`TranscriptsPanel.tsx`'s message/tool-call rendering (`MessageView`, `LlmCallView`, `TurnRow`,
`toolCallsIn`) was exported rather than duplicated, so the new `CopilotTranscriptsPanel` (no
agent-picker — the copilot is a single agent) reuses it directly. `CopilotFilesPanel` and
`CopilotLimitsPanel` are new, deliberately smaller than their mission counterparts (no edit/
provenance for Files; no per-agent breakdown for Limits) — matching what actually applies to a
single-agent, non-git-tracked workdir rather than forcing reuse of a richer component built for
a different shape of data.

---

## Consequences

- The copilot now writes to `agentTurnStats`/`missionStats` — a small, permanent addition to
  those collections' write volume. Negligible: one row per copilot turn, same order of magnitude
  as any single mission agent.
- `GET /api/copilot/files` is a new, permanent gap in per-user isolation (see above) — logged in
  the threat model, not silently accepted. No code changes needed to fix it later beyond adding a
  per-user subdirectory and updating `COPILOT_WORKDIR` resolution.
- The spend cap's synchronous-block design means a very cheap message sent one token before the
  cap is reached can still push spend slightly over it before the *next* message is blocked —
  same "check before, not during" granularity every per-request rate/spend gate in this codebase
  already accepts (e.g. the mission-wide cap check happens between turns, not mid-turn).
- **Verification performed**: full unit + integration suite green, including new coverage —
  `copilot-files.unit.test.ts` (path-boundary + symlink-escape rejection, pure filesystem, no
  Mongo) and `copilot-visibility.integration.test.ts` (real MongoDB: `getCopilotSpendCap`/
  `setCopilotSpendCap` round-trip, `checkCopilotSpendCap`'s allow/block decision at the cap
  boundary, and `transcript-queries.ts`'s four functions working with no `missions` document
  present for the missionId).
- **Not yet verified live**: the actual cockpit UI (Transcripts turn timeline, Files browser,
  Limits cap enforcement) against a real running control-plane copilot session — needs a
  post-deploy manual pass, same two-step verification gap prior ADRs in this file have noted.

---

## Related

- [ADR-0016](0016-copilot-architecture.md) — control-plane vs. mission copilot architecture split
- [ADR-0017](0017-cost-tracking-single-source-fresh-reads.md) — the fresh-read-no-cache principle
  `readCopilotSpend`/`checkCopilotSpendCap` follow
- [ADR-0018](0018-limit-configuration-single-source-fresh-reads.md) — the mission spend-cap design
  this one deliberately diverges from, and why
- `docs/security/threat-model.md` TB-21 — the new Files route's trust boundary and known gap
- `packages/control-plane/src/transcript-queries.ts` — shared query functions
- `packages/control-plane/src/copilot-files.ts` — path-boundary-checked file reads
- `packages/control-plane/src/copilot-router.ts` — new routes, `checkCopilotSpendCap`
- `packages/control-plane/src/users.ts` — `copilotSpendCapUsd` field and accessors
