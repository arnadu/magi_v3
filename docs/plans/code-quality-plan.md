# Code-quality plan (post-audit, Sprint 28f close-out)

Status: **agreed 2026-10-19**, in progress. Follows the audit remediation
([audit-oct26-remediation-plan.md](audit-oct26-remediation-plan.md)).

## Context

The audit remediation (Sprint 28f) is complete apart from operator steps. Its deferred
maintainability work (#84: R-2, R-15) and the code-quality issues filed alongside it (#34, #36,
#43, #44, #60, #73) remain. This document is the executable plan; the progress log at the end records each step.

**Ranking principle:** order the steps by what has actually produced bugs, not by file size.
- Field-name drift between writers and readers. On 2026-10-18 this caused the PostMessage stats
  regression and the stale `cost.total` fixture; earlier it caused #53's $0 spend.
- The two loop god-functions, where #55, #56, #64 and #65 lived.
- Small hidden debt that has masked failures before.

**Rules for every step:**
- A refactor commit is a move. Tests are unchanged and green before and after. Check moves with
  `git diff -M`. Keep each commit to about 600 lines.
- Characterization tests come first, in their own commit, wherever the public interface has
  none.
- Every step tightens a gate: `structure.allow.json` (`--update`), `tripwires.allow`, the Biome
  complexity exemptions in `biome.json`, or the coverage floors in `vitest.config.ts`.
- `npm run verify` (pre-push) on every commit; confirm each push with `git ls-remote`.
- `npm run test:integration` at the end of steps 1, 2 and 4.
- Update `docs/code-structure.md`, and tick the plan doc's progress log, in the same commit as
  the change.

## Baseline (measured 2026-10-19)

| Measure | Now |
|---|---|
| Oversize files (> 600 lines) | 39 |
| Files exempt from cognitive complexity 25 | 32 |
| Biggest functions | `createMissionCopilotTools` ≈1008 (file 1139); `createCopilotTools` ≈776 (file 902); `CostTimeline` 545 (TracePanel 935); `runAgent` 449; `runOrchestrationLoop` 419 (+ `dispatchOnePass` 157); `executeAction` ≈388 (copilot-router 800) |
| T8 empty catch | 7 (allowance 11) + 21 untracked `.catch(() => {})` |
| T9 casts | 20 (allowance 20): 9 `as any`, 6 `as unknown as`, 0 ts-ignore. The rest of the T9 count is matched by the pattern; re-count when starting step 3 |
| T11 history comments | 107 (allowance 115) |
| Bare `console.error(e)` | 7, all CLI/entry `main().catch` |
| Model-id literals in code | 11 lines in 5 files |
| `.collection(` call sites | worker 48, control plane 78 |
| Coverage floors (stmts/branches/fns) | agent-config 93/92/87, worker 51.5/81.3/70.1, control plane 47.2/87.5/73, cockpit excluded |

---

## Step 0 — Ratchets to today (≈1 h, 1 commit)

- `scripts/audit/tripwires.allow`:
  - T8 `maxcount=7`, T11 `maxcount=107`.
  - T10: replace `maxcount=1` with a regex entry for `loader.ts:163`. Reason: the ADR-0034
    default is applied at the three creation sites; the field stays optional so stored or legacy
    configs parse.
- Extend T8 to also match `.catch(() => {})` (`\.catch\(\(\)[[:space:]]*=>[[:space:]]*\{\}\)`)
  with `maxcount=28`. That is 7 empty catches plus 21 `.catch(() => {})`.
- Add a planted sample under `scripts/audit/selftest/` and run `tripwires.sh --selftest`.

## Step 1 — Typed stored documents, R-15 (≈2–2.5 d, ~9 commits)

**Goal:** one canonical type per collection. Every writer and reader uses it; a wrong field or
dotted path fails `tsc`.

**Findings that shape it:**
- `scheduled_messages` has four disagreeing shapes: worker `ScheduleDoc`
  (`schedule-ingest.ts:73`), and CP copies in `scheduler.ts:43`, `copilot-tools.ts:104` (3
  statuses, no `kind`/`pendingFire`) and `copilot-schedule-actions.ts:21`.
- `missions` has ≈10 CP shapes (`missions.ts:46` `MissionDoc` plus local restatements in
  `copilot-tools`, `proxy`, `scheduler`, `copilot-router`, and `*Like`/`Row` variants). The
  worker has none.
- `StoredLlmCall` (`transcript-queries.ts:78`) restates `LlmCallLogEntry`
  (`llm-call-log.ts:97`).
- Cockpit `llm-call-types.ts` hand-mirrors CP API shapes.
- Most sites are untyped: mailbox 14 of 16, conversationMessages 10 of 11, llmCallLog 9 of 11.
- `agent-config` depends only on `zod@4` and `yaml`; the worker is on `zod@3`. **Decision:** the
  stored types are plain TS interfaces with no zod, so the zod split is not touched.

**1a. Create `packages/agent-config/src/stored/` (types only)**
- Files: `missions.ts`, `scheduling.ts`, `llm-calls.ts`, `mailbox.ts`, `stats.ts`,
  `conversation.ts`, `resources.ts` (missionResources, resourceAlertState, resourceSnapshots,
  machineSegments, platformResources), `anomalies.ts`, `objectives.ts`, `config-revisions.ts`,
  `copilot.ts` (pendingActions), `users.ts`, and `index.ts`.
- Move the most complete existing definition into each file; do not invent shapes:
  - `ScheduleDoc` becomes `ScheduledMessageDoc`, with the full status union.
  - CP `MissionDoc` becomes canonical, gaining the `resize`/`upgrade`/`daemon` fields used
    elsewhere.
  - Also move `LlmCallLogEntry`/`LlmCallUsage`/`LlmCallCost`, `MailboxMessage`,
    `AgentTurnStats`/`MissionStats`/`LlmCallStats`, `ConversationDoc`, and the others.
- The fields that reference pi-ai `Message`/`AssistantMessage` and mongodb `ObjectId` use
  `import type`. Add `@mariozechner/pi-ai` and `mongodb` to agent-config as
  `peerDependencies` + `devDependencies` (type-only, erased at runtime). Export them via the
  agent-config `index.ts`.
- The old modules re-export (`export type { LlmCallLogEntry } from "@magi/agent-config"`), so
  this commit is a pure move.

**1b. `stored/collections.ts`, typed accessors**
- `COLLECTION_NAMES` (const map), a `CollectionName` type, and `storedCollections(db: Db)`
  returning `{ missions: Collection<MissionDoc>, scheduledMessages: …, … }`.
- A `PER_MISSION_COLLECTIONS` list. `cli-reset.ts:109-123` uses it instead of its own 11 names.
- Unit test: every name in CLAUDE.md's "Storage (MongoDB collections)" list is in
  `COLLECTION_NAMES` and vice versa (a claims-are-tested check).

**1c. `stored/paths.ts`, typed dotted paths**
- A `Path<T>` recursive type (depth-limited to 4).
- `field<T>()(p: Path<T>) → p` for `$match`/`$set` keys, and `ref<T>()(p) → \`$${p}\`` for
  aggregation expressions.
- Unit tests, including a `// @ts-expect-error` line proving that a wrong path fails to compile.
  This is the one sanctioned ts-expect-error, in tests only.

**1d. Migrate call sites, one collection per commit, worst first**
1. `scheduled_messages`: CP `scheduler.ts`, `copilot-tools.ts` (ListSchedule),
   `copilot-schedule-actions.ts`, `resource-upgrade.ts`; worker `mission-copilot-schedule-tools.ts`,
   `monitor-routes/schedule`, `monitor-tool-servers`. Delete the three CP copies.
2. `llmCallLog`: `transcript-queries.ts` (`StoredLlmCall` → `LlmCallLogEntry`), the aggregates in
   `copilot-daemon`, `copilot-router`, `index.ts`, `scheduler`, `cli-analyze-dump`. All
   `$usage.*` strings go through `ref<LlmCallLogEntry>()`.
3. `missions`: CP restatements become `MissionDoc` or `Pick<MissionDoc, …>`; the worker's untyped
   sites (`daemon-boot/*`, `mission-config-revisions`, `mission-copilot-tools`) are typed.
4. `mailbox` and `conversationMessages`. This removes the 5 `as any` in
   `monitor-routes/agent-sessions.ts` (#43's core).
5. `agentTurnStats` and `missionStats`: drop CP `mission-stats-summary.ts` partial copies and the
   inline `{lastTurnAt}` in `resource-queries.ts:32`.
6. Remaining collections: `missionResources` (writer `resource-sampler.ts:133` typed),
   `platformResources` (string `_id`, which removes both `"atlas" as unknown as never` casts),
   anomalies, alerts, and the rest.

**1e. Tripwire T13**
- Pattern: `\.collection(<[^>]*>)?\([[:space:]]*["']`, i.e. a raw collection-name literal outside
  `packages/agent-config/src/stored/collections.ts`. Initial allowance = the remaining count,
  driven to 0 by the end of 1d.
- `atlas-usage.ts` (dynamic names from `listCollections`) gets a regex entry with its reason.

**1f. Contract test `packages/control-plane/tests/stored-schema.consumers.unit.test.ts`**
- Uses `tests/support/fake-db.ts`. Fixtures are produced by the real writers: `StatsCollector`
  (turn plus lifetime), the llm-call-log repository, `ingestSchedules` plus scheduler
  `deliver()`, and `MailboxRepository.post`.
- Then read them back through every consumer: `mission-stats-summary`, `transcript-queries`,
  copilot `ListSchedule`, the worker `ListScheduledMessages` tool, and the trace queries. Assert
  non-default values arrive, i.e. no `0`, `undefined` or `$0`.
- Extends the seed in `transcript-queries.unit`.

**1g. Cockpit API types (last commit of the step)**
- Move CP API DTOs (`LlmCallSummary`, `LlmCallDetail`, `CallUsage` in `transcript-queries.ts`)
  to `agent-config/src/api/`.
- Cockpit adds `"@magi/agent-config": "*"` as a dependency, with **type-only** imports
  (erased by Vite). `llm-call-types.ts` re-exports and loses its "mirrors" comment.

**Done when:**
- T13 is at 0.
- No collection shape is declared outside `stored/`, except deliberate `Pick<>` views.
- The CLAUDE.md list test is green.
- The contract test covers every collection with more than one reader.
- The integration suite is green.

## Step 2 — Agent loop core, R-2 rest and #60 (≈2 d, ~8 commits)

### 2a. Characterization tests first

These are new unit tests. `vi.mock("../src/loop.js")` drives `runInnerLoop`'s `onMessage`/result,
with in-memory repos as in `orchestrator.unit.test.ts`.

**`agent-runner.unit.test.ts` gains:**
- The supervisor fallback is posted when no PostMessage reached the supervisor, and not posted
  when one did.
- `disabledTools` and `additionalTools` filtering.
- A `LimitExceededError` gives `finalizeTurn(aborted=true)` and is not re-thrown.
- A non-limit error is re-thrown after `finalizeTurn`.
- The conversation-recovery retry fires only on its four conditions, and resets `currentCallSeq`.

**`orchestrator.unit.test.ts` gains:**
- The `waitForBudget` pause holds a dispatch.
- CLI mode exits when nothing is dispatchable.
- `teardownOnExit` runs.
- `dispatchReady` coalescing: two overlapping calls give one extra pass.

### 2b. `runAgent` (agent-runner.ts 252–700)

- New `TurnState` interface holding the 8 shared `let`s: `history`, `mentalMapHtml`,
  `turnNumber`, `callSeq`, `postedToSupervisor`, `lastAssistantText`, `limitAborted`,
  `lastCallAborted`. Closures read and write `state.x` instead of locals. This first commit only
  mechanically replaces `let`s with state fields.
- Extract into `agent-runner-phases.ts`, or a new `agent-runner-setup.ts` if that file passes 600
  lines:
  - `resolveAgentAcl` (258–282)
  - `loadTurnHistory` (284–327)
  - `reflectIfNeeded` (329–360)
  - `buildTurnTools` (413–497)
  - `createTurnHooks` (499–575)
  - `runWithRecovery` (589–667)
- `runAgent` becomes about 60 lines: setup → hooks → `startTurn` → try `runWithRecovery` /
  fallback → catch / finally `finalizeTurn`.
- **Separate fix commit**, a behaviour change with its own test. The recovery retry's result is
  discarded today: the fallback reads the first `result.messages`, and `lastCallAborted` is not
  recomputed. Make the fallback and abort flag use the retry's result.

### 2c. `runOrchestrationLoop` (orchestrator.ts 217–644)

New modules:
- `orchestrator-setup.ts`: `provisionTeam` (244–283: users, workspaces, isolation, git) and
  `createAgentContext` (303–324).
- `orchestrator-dispatch.ts`: `createDispatcher(loopState, deps)`, which returns
  `{dispatchReady, checkIdle, active, activePromises}`. Inside it, `dispatchOnePass` (412–569) is
  split into:
  - `selectNextAgent` (skip rules)
  - `passGates` (step, TTY, budget, abort re-checks)
  - `startDispatch` (`markRead`, per-dispatch AbortController, timeout timer + `agent-timeout`
    anomaly, `runAgent` with `.catch`/`.finally`)
- `LoopState` holds `totalRuns`, `maxRuns`, `dispatchInFlight`, `dispatchAgainRequested`,
  `inputBuffer` and `rl`.

The main loop's two modes become `runDaemonMode` (575–586) and `runCliMode` (588–629). Shutdown and
`finally` stay in `runOrchestrationLoop`, which drops to about 60 lines.

### Done when (step 2)

- `runAgent`, `runOrchestrationLoop` and `dispatchOnePass` are each under 120 lines.
- `agent-runner.ts` and `orchestrator.ts` are off `structure.allow.json` (run `--update`) and off
  the Biome exemption list.
- Closes #60 and ticks #84 R-2.
- Integration suite green: these 9 files exercise the loop.

## Step 3 — Small debt to zero (≈0.5–1 d, ~4 commits)

**Empty catches (7):**
- The 5 unlinks (`job-runner.ts:214/378/469`, `daemon.ts:446`, `job-recovery.ts:179` status
  mirror) go through a new `removeIfExists(path, context)` in the worker. It ignores `ENOENT` and
  logs anything else with operation, path and consequence.
- `job-runner.ts:455` `process.kill`: ignore only `ESRCH`, log the rest.
- `monitor-server.ts:463` socket destroy: add a one-line reason comment (teardown of an
  already-closed socket) as a regex entry.

**The 21 `.catch(() => {})`:**
- Each one either logs (reflection, browse-web close, copilot-daemon, copilot-waker,
  resource-upgrade) or carries a reason comment and a regex entry (cockpit `auth.ts`
  best-effort logout, mail-waiter stream close).
- T8 then goes to `maxcount=0` with only reasoned regex entries.

**Casts (T9 → 0):**
- `agent-sessions.ts` (5) and `atlas` `_id` (2) are already gone in step 1.
- `cli-tail.ts:74`: use `ChangeStreamInsertDocument<MailboxMessage>`.
- `objectives/repository.ts:141`: type the collection generic.
- `conversation-repository.ts:291`: a type guard.
- These four stay, each as a regex entry with its constraint:
  - `models.ts:147`: pi-ai's `getBuiltinModel` id union does not include runtime OpenRouter ids.
  - `log-tee.ts:57/62`: monkey-patching `process.stdout.write` overloads.
  - `document-processor.ts:856/925`: library typings for exceljs Buffer and mammoth.

**Bare `console.error(e)` (7 CLI entry points and CP `index.ts:342`):**
- A shared `exitOnFatal(tag)` in the worker (`cli-fatal.ts`), and its control-plane equivalent,
  prints `[<tag>] fatal: <message>` plus the stack, then exits 1.
- New tripwire T14 for `console\.error\((e|err|error)\)`.

**Model ids:**
- `DEFAULT_MODEL_ID` and `DEFAULT_VISION_MODEL_ID` in `agent-config/src/models.ts`.
- Used by `env-catalog.ts:54/60`, `cli.ts:92/96`, `daemon-boot/model-pricing.ts:14/20` and
  `copilot-runtime.ts:68`. `models.ts` (price table) keeps its literals as the one sanctioned
  site.
- New tripwire T15 for `"claude-(sonnet|haiku|opus)-[0-9]` outside `agent-config/src/models.ts`
  and the worker's `models.ts`.

**T11 stays a ratchet.** Lower it with `--update`-style edits each time steps 1–5 shrink it.

## Step 4 — Copilot tool files, #34 and #36 (≈1.5–2 d, ~7 commits)

### 4a. `mission-copilot-tools.ts` (1139 lines)

The precedent is `mission-copilot-schedule-tools.ts`: a deps interface plus one private factory
per tool and a `create…Tools(deps)` aggregator.
- `mission-copilot-tool-deps.ts` holds `MissionCopilotToolDeps`: config fields plus
  `missionConfigWriter`, `monitorGet`, `monitorPost`, `auditPost`.
- `mission-copilot-tool-text.ts` holds `wrapTrustBoundary`, `escapeRegex` and `fileNodeToText`
  (lines 85–130).
- One file per family:

  | File | Family | Tools |
  |---|---|---|
  | `-config-tools.ts` | A | `SaveMissionConfig`'s 150 lines are split into validate / diff / write helpers |
  | `-objectives-tools.ts` | B | |
  | `-monitoring-tools.ts` | C | 8 tools |
  | `-resource-tools.ts` | D | cost series, lifetime, spend cap |
  | `-intervention-tools.ts` | E | |
  | `-diagnostics-tools.ts` | F | |
  | `-github-tools.ts` | G | with its control-plane fetch helper |

- `createMissionCopilotTools` becomes about 40 lines and keeps the returned array order.
  `mission-copilot-tools.unit.test.ts` is the safety net, unchanged.

### 4b. Control-plane `copilot-tools.ts` (902 lines)

- Switch to a deps object `{db, pushEvent, pending, userId}`. Callers change in the same commit.
- Split into `copilot-read-tools.ts` (B1, 8 tools), `copilot-propose-tool.ts` (B2),
  `copilot-github-tools.ts` (B3) and `copilot-objective-tools.ts` (4 tools).
- Shared `copilot-tool-result.ts` holds `ok`/`err`/`monitorFetch`. Delete the unused
  `_monitorPost`. Doc types come from step 1's `stored/`.

### 4c. `copilot-router.ts` `executeAction` (385–772)

- Move each case's handler beside the existing `copilot-actions.ts` registry, as
  `{schema, handler}` (R-3's design).
- `save_session_config` (≈100 lines) goes to `copilot-session-config-action.ts`. Launch, suspend,
  resume and fix-volume handlers join `copilot-launch-actions.ts`. Schedule handlers join
  `copilot-schedule-actions.ts`.
- `executeAction` becomes a lookup and dispatch.
- The router keeps routes only. Move `readCopilotSpend`/`checkCopilotSpendCap` to
  `copilot-spend.ts`.

### Done when (step 4)

- No factory or dispatcher is over 120 lines.
- The four files are off both allowlists.
- Closes #34 and #36 (re-scope #36's `document-processor.ts` remainder to "Later").

## Step 5 — Cockpit, #73 (≈2 d, ~7 commits)

### 5a. `data.ts` (1022 lines) → `src/api/`

- `http.ts` holds `request`, `AuthError`, `ForbiddenError`, `api<T>` and `mp`.
- One module per domain: `missions`, `drafts`, `templates`, `conversations`, `transcripts`,
  `files`, `trace`, `limits`, `copilot`, `copilot-visibility`, `schedule`, `log`, `config`,
  `stats`.
- `data.ts` becomes a re-export barrel, so no import churn. A later optional commit points imports
  at `api/*` and deletes the barrel.

### 5b. `TracePanel.tsx` (935 lines) → `src/trace/`

- `trace-geometry.ts` gets the constants, `seqColor` and the pure scale/lane/brush computations
  pulled out of `CostTimeline` (unit-testable).
- `CostTimeline.tsx` is split into `CostChart`, `EventLanes` and `OverviewBrush`.
- `CostBars.tsx`, `InteractionHeatmap.tsx` and `StatTile` each get their own file.
- `TracePanel.tsx` keeps only the panel.

### 5c. `App.tsx` (814 lines)

- `app-hooks.ts`: `useAuthState`, `useView`, `useMissionStatus`, `useMissionName`.
- `Header.tsx`: `Header`, `MissionStatusButton` and `SignOutButton` (moved in).
- `AgentErrorBanner.tsx`, `LoadingView.tsx`.
- `App` keeps the view routing.

### 5d. Shared hook

- `useApiResource(fetcher, deps, {pollMs?})` combines `useLoadError` (`load-error.tsx:7`) and
  `useVisiblePoll` (`use-visible-poll.ts:9`), returning `{data, error, reload}`.
- Adopt it in the panels touched by 5a–5c; other panels adopt it when next edited.

### 5e. Coverage

- In `vitest.config.ts`, include `packages/cockpit/src/**/*.ts` (pure modules, not `.tsx`) in
  coverage, with floors at the measured level.
- New tests:
  - `trace-geometry.unit`
  - `api-http.unit` (status → error class mapping with stubbed `fetch`)
  - pure helpers of LimitsPanel, ConfigPanel and FilesPanel as they are extracted

### Done when (step 5)

- `data.ts`, `TracePanel.tsx` and `App.tsx` are off `structure.allow.json`.
- `App.tsx` is off the Biome exemptions.
- Cockpit floors exist. Closes #73.

## Step 6 — Risk-weighted coverage, #44 (alongside steps 1–5)

- Per-file floors in `vitest.config.ts` at 90% statements for: `safe-path`, `ssrf`, `safe-http`,
  `spend-policy`, `mission-limits`, `limits`, `job-runner`, `schedule-ingest`, `auth`,
  `auth-limiter`, `copilot-actions`, `pending-actions`.
- Before setting them, measure with `npm run test:coverage` and raise any that are below 90% with
  tests.
- After each step, raise the package floors to the new measured value minus 0.2. Never lower
  them.
- Targets: worker ≥ 60 and control plane ≥ 55 statements by the end. Closes #44.

## Later (not scheduled; issues stay open)

- `document-processor.ts` per-format split, together with PDF extraction off-thread (#79).
- `resource-upgrade.ts` / `resource-report.ts` phase split (#59).
- `monitor-server.ts` remainder of #43: close it if step 1 covers it.
- Rest of #74 (control plane still imports worker factories through the barrel).
- Worker `zod@3` → `@4` alignment.
- #68 Express 5 and firebase; #69 Python.
- Remaining oversize files: extract when a feature next touches them.

## Order and effort

| # | Step | Effort | Depends on |
|---|---|---|---|
| 0 | Ratchets | 1 h | — |
| 1 | Typed stored documents | 2–2.5 d | — |
| 2 | Loop core | 2 d | 1 (state types) |
| 3 | Small debt | 0.5–1 d | 1 (casts vanish with typed docs) |
| 4 | Copilot tools | 1.5–2 d | 1 (doc types) |
| 5 | Cockpit | 2 d | 1g (API types) |
| 6 | Coverage | alongside each | — |

About 9–10 working days. This is up from the summary's 8, after measuring: 126 collection sites,
and the copilot and cockpit files are larger than first estimated. Steps 2, 4 and 5 are mutually
independent once step 1 is done.

## Exit criteria

- Structure allowlist ≤ 30 files (from 39); no allowlisted function over 300 lines.
- Biome complexity exemptions ≤ 24 (from 32).
- T8, T9, T13, T14 and T15 at 0, apart from reasoned regex entries.
- The contract test covers every multi-reader collection; the CLAUDE.md collection list is
  tested.
- Coverage floors raised (step 6) and cockpit floors added.
- `docs/code-structure.md` current.
- Closed: #34, #36, #44, #60, #73, and #43 (or re-scoped). #84's R-2 and R-15 are ticked.

## Verification

- Per commit: `npm run verify`. For moves, `git diff -M --stat` shows renames; tests unchanged.
- Step 0: `tripwires.sh --selftest`.
- Step 1: the `tsc` negative test (`@ts-expect-error` on a bad path) and the contract test;
  integration suite green.
- Step 2: the new characterization tests pass before *and* after the refactor commits;
  integration suite green.
- Step 4: copilot unit suites unchanged and green. On dev after deploy, open a mission's copilot
  and run one read tool and one proposal end to end.
- Step 5: `npm run build -w packages/cockpit`. Open dev in a browser: missions list, a mission's
  Trace tab (brush drag), Limits save, sign out.
- After each push: CI green, and a deployed dev smoke check of the area touched.

## Progress log

- 2026-10-19 — plan agreed (summary), then expanded into this detailed plan.
- 2026-10-19 — **Step 0 done**: T8 7, new T8b (`.catch(() => {})`) 21, T11 107, T10 a reasoned regex entry; selftest covers T8b.
- 2026-10-19 — **Step 1 code done** (R-15): `agent-config/src/stored/` holds `COLLECTION_NAMES`,
  `storedCollection(db, key)`, `PER_MISSION_COLLECTIONS` and the canonical types of every
  collection read by more than one module (missions, scheduled_messages, llmCallLog, mailbox,
  conversationMessages, agentTurnStats, missionStats, missionAnomalies, missionResources,
  platformResources); single-module collections keep their module's type and take the name from
  the map. `field`/`ref` typed paths with compile-time tests (`type-tests/paths.ts`). T13 bans
  collection-name literals (0 left). Contract test `stored-schema.consumers.unit`. Transcript API
  shapes shared with the cockpit (`agent-config/src/api/`). Found and fixed on the way:
  **F-071** (copilot spend cap counted only the last day: it summed the pruned call log),
  `cli-reset` never deleted `objectivesEvents`, the scheduler's mail delivery bypassed
  `postMailbox`, CLAUDE.md's collection list missed six collections (now tested). T9 20 → 14.
  Deviation: single-module collections are not moved (their types depend on module-local domain
  types such as the objectives fold); the zod 3/4 split is untouched (types only).
- 2026-10-19 — **Step 1 gate passed**: integration 219/219 (one LLM-timing flake in
  `tool-api-news-digest`, green on rerun). Pushed.
- 2026-10-19 — **Step 5 mostly done**: cockpit `data.ts` → `src/api/` (12 modules), `App.tsx`
  814 → 79 lines (app-hooks, Header, HomeView, MissionDashboard, TabBar; off the complexity
  exemptions), `TracePanel.tsx` 935 → 113 with `src/trace/` (pure geometry with tests,
  `useZoomBrush`, one file per chart piece, nothing over 120 lines), `useApiResource` (Schedule and
  Runtime adopt it), cockpit coverage floors on its pure modules. Not yet verified in a browser.
- 2026-10-19 — **Step 2 code done**: `runAgent` 449 → ~120 lines over `TurnState`
  (`agent-runner-turn.ts`); fix: the conversation-recovery retry's outcome is now the turn's
  outcome (it was discarded). `runOrchestrationLoop` 419 → ~60 lines (`orchestrator-setup.ts`,
  `Dispatcher` class). Characterization tests first (10 + 3), unchanged across the refactor.
  Both files off the structure allowlist and the complexity exemptions (32 → 29). Worker and
  control-plane coverage floors still to be raised from CI's numbers (local runs measure higher).
- 2026-10-19 — **Step 2 gate passed** (10 loop integration files, 11/11). Pushed.
- 2026-10-19 — **Step 3 done**: T8/T8b at zero (`removeIfExists` for file removals, ESRCH-only
  kill, every meaningful swallowed rejection logged; stream/browser teardown closes under one
  reasoned entry), T9 at zero (3 casts removed by typing, 6 kept with stated constraints;
  comment prose no longer counted), T14 (`exitOnFatal` at the 7 entry points), one
  `DEFAULT_MODEL_ID`/`DEFAULT_VISION_MODEL_ID` and T15. Found and fixed: **F-072** — Claude
  Opus 4.8 was priced at Sonnet rates (no `resolveModel` entry; ~40% low cost and cap checks).
- 2026-10-19 — **Step 4 code done**: mission-copilot tools (1008-line factory) → seven family
  modules with one factory per tool; control-plane copilot tools → four family modules;
  `executeAction` → handler registry; copilot router → route registrars; shared
  `applyTeamConfigPatch` replaces two restated merge-and-validate copies. Structure allowlist
  39 → 31 files, complexity exemptions 32 → 27.

