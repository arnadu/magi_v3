# MAGI V3 — Code Structure

Inventory of files and functions that have crossed the size/concern thresholds in `CLAUDE.md`'s
"Code Structure" section (roughly 500 lines per file, 80–100 lines per function), and their
decomposition status. This document tracks structural debt the way `docs/operational-resilience.md`
tracks failure-mode debt — a living inventory, not a one-off report.

**Keep this document current.** Use `/code-structure-review` periodically and at sprint close to
sweep for new entries, confirm existing status, and catch drift (a tracked file growing further
before it's decomposed).

Originated from an independent audit (`docs/code-review-audit-report-2026-08-09.md`) that flagged
four large files as evidence of poor separation of concerns. Verification found the claim true for
two of the four and overstated for the other two — see `docs/code-review-audit-response-2026-08-12.md`
for the full analysis. This document is the durable tracking artifact that verification produced.

---

## Inventory

| File | Lines | Concerns mixed | Decomposition risk | Status | Tracking issue |
|---|---|---|---|---|---|
| `packages/agent-runtime-worker/src/monitor-server.ts` | 1154 | `handleRequest` decomposed 2026-09-14 into a 36-line auth-gate + route-table dispatch; all 34 routes now live in `monitor-routes/*.ts` (15 files, one per cluster, factory functions taking an explicit `deps` object). 2026-10-16: the file surface (`serveFileNode`, `handleDownload`, `addToZip`, the containment/git-metadata/upload-name helpers and the file-type constants) moved to `monitor-files.ts` (335 lines) when it gained `safe-path.ts` containment (F-037) — that code is one concern with its own tests. Remaining bulk is independent private helpers (`handleUpload`, `handleFileEdit`, `statusPayload`, `watchMailbox`, etc.) and shared constants/types — no single god-function left | Low | Done — `handleRequest` decomposition complete; remaining file is many small independent pieces, not a decomposition candidate per CLAUDE.md's Code Structure guidance | [#32](https://github.com/arnadu/magi_v3/issues/32) |
| `packages/agent-runtime-worker/src/daemon.ts` | 781 | `main()` decomposed 2026-09-15 from ~792 lines to ~213: a `BootContext` threaded by value, with 19 phases (env parsing, Mongo connect, team-config load, agent-identity provisioning, repo/workspace construction, monitor/tool-server startup, job-runner start, mail-waiter, mission-copilot-tools, orchestration callbacks, etc.) each extracted into `daemon-boot/*.ts` (19 files) as `Pick<BootContext,...>`-typed functions, merged into `ctx` via `Object.assign`. `main()` itself is now a top-to-bottom sequence of named phase calls. Remaining in this file: `main()`'s own process-lifecycle triad (unchanged per design — see the plan), plus `ensureAgentUsers`-adjacent runtime functions (`runPendingJobs`, `startJobRunner`, `logMemoryUsage`, `dataKeysEnv`, `cancelBackgroundJob`) that are ongoing runtime concerns, not boot phases | Low | Done — all 19 planned boot phases extracted with unit test coverage; verified against `daemon-job.integration.test.ts`'s real end-to-end daemon boot after every risk-bearing step | [#33](https://github.com/arnadu/magi_v3/issues/33) |
| `packages/agent-runtime-worker/src/mission-copilot-tools.ts` | 98 | **Decomposed (#34, 2026-10-19).** A composition over seven family modules (`mission-copilot-{config,objectives,monitoring,resource,intervention,diagnostics,github}-tools.ts`, plus the existing schedule module), one private factory per tool; `mission-copilot-tool-deps.ts` (shared deps: monitor calls, config writer, audit post) and `mission-copilot-tool-text.ts` (trust-boundary and file-text helpers) | Low | Done | [#34](https://github.com/arnadu/magi_v3/issues/34) |
| `packages/control-plane/src/missions.ts` | 407 | **Decomposed (R-1, 2026-10-17).** The router is a list of six registrars, one module per concern — `mission-routes-read.ts` (list, one mission, conversations, roster, operator mail), `-transcript.ts`, `-config.ts` (config/draft get+put), `-launch.ts`, `-limits.ts` (Limits panel + objectives), `-lifecycle.ts` (create, draft, suspend, resume, disabled delete). Each route is a module-level handler factory over `MissionRouteDeps` (`mission-scope.ts`); the three handlers that were over 120 lines lost one phase each (`checkMentalMapEdits`, `resolveCreateConfig`, `reprovisionOnVolume`). What remains in `missions.ts` is the `MissionDoc` type, `readLimits` (still complexity-allowlisted), the upgrade-reset and objectives readers | Low | Done | [#35](https://github.com/arnadu/magi_v3/issues/35) |
| `packages/agent-runtime-worker/src/agent-runner.ts` | 353 | **Decomposed (R-2, 2026-10-19).** `runAgent` is about 120 lines of named phases over an explicit `TurnState` (mental map, turn number, call sequence, supervisor-posted flag, last text). `agent-runner-turn.ts` holds the stateful phases — `prepareTurn`, `createTurnHooks`, `buildTurnTools`, `runWithRecovery` — and `agent-runner-phases.ts` the stateless ones. Characterization tests (`agent-runner-turn.unit`) pinned the behaviour first; the retry-outcome fix landed separately | Low | Done | [#84](https://github.com/arnadu/magi_v3/issues/84) |
| `packages/agent-runtime-worker/src/document-processor.ts` | 1146 | Not yet characterized. **Drift**: grew from 887 (2026-08-12) to 1146 entirely before Sprint 28g started (zero net change during this sprint) — stale record, not new growth from this work | Unknown | Backlog — needs triage | [#36](https://github.com/arnadu/magi_v3/issues/36) |
| `packages/control-plane/src/copilot-router.ts` | ~140 | **Decomposed (#36, 2026-10-19).** Routes only, in registrars (`registerChatRoutes`, `registerHistoryRoutes`, `copilot-visibility-routes.ts`); `executeAction` is a `Record<ActionType, handler>` lookup in `copilot-action-handlers.ts`; the spend helpers are `copilot-spend.ts`. Config edits from both copilots go through `applyTeamConfigPatch` (agent-config) | Low | Done | [#36](https://github.com/arnadu/magi_v3/issues/36) |
| `packages/control-plane/src/copilot-tools.ts` | 64 | **Decomposed (#36, 2026-10-19).** `createCopilotTools` keeps its signature and composes `copilot-read-tools`, `copilot-propose-tool`, `copilot-github-tools` and `copilot-objective-tools` (one factory per tool); `copilot-tool-deps.ts` holds the deps and `ok`/`err`/`monitorFetch` | Low | Done | [#36](https://github.com/arnadu/magi_v3/issues/36) |
| `packages/control-plane/src/resource-upgrade.ts` | 788 | Born large in Sprint 28g (ADR-0031 step 2.3): already siloed into named sections (request/same-shape-renewal/revert/sweeper/suspend-with-revert) sharing a few small private helpers (`recordAnomaly`, `describeShape`, `notify`); no individual function exceeds ~90 lines | Low | Backlog | [#59](https://github.com/arnadu/magi_v3/issues/59) |
| `packages/control-plane/src/resource-report.ts` | 662 | Born large in Sprint 28g (ADR-0032 step 6.1): three genuinely separable phases already marked by section-header comments — assemble (`buildDailyReport`/`buildMissionRow`/`computeFlags`, I/O-heavy), render (`renderDailyReport`, pure text formatting), and persist/schedule (`claimAndPersistSnapshot`/`postReportMail`/`runDailyReportsIfDue`) — a near-mechanical three-way file split | Low | Backlog | [#59](https://github.com/arnadu/magi_v3/issues/59) |
| `packages/agent-runtime-worker/src/orchestrator.ts` | 328 | **Decomposed (#60, 2026-10-19).** `runOrchestrationLoop` is setup → dispatch → `runDaemonMode`/`runCliMode` → shutdown. `orchestrator-setup.ts` (provisioning + isolation check, terminal input, run context, `postUserLine`) and `orchestrator-dispatch.ts` (the `Dispatcher` class: coalesced passes, skip rules, step/budget gates, per-run timeout, crash reporting) | Low | Done | [#60](https://github.com/arnadu/magi_v3/issues/60) |
| `packages/cockpit/src/data.ts` | 19 | **Decomposed (#73, 2026-10-19).** A re-export barrel over `src/api/` — `http.ts` (`request`, `AuthError`/`ForbiddenError`, `api`, `mp`) and one module per domain (missions, drafts, templates, conversations, transcripts, files, trace, limits, copilot, schedule, config), largest 166 lines | Low | Done | [#73](https://github.com/arnadu/magi_v3/issues/73) |
| `packages/cockpit/src/TracePanel.tsx` | 113 | **Decomposed (#73, 2026-10-19).** Only the panel remains; `src/trace/` holds the chart geometry (`trace-geometry.ts`: constants, palettes, `fullTimeDomain`, `cumulativeCostLines` — unit-tested), `useZoomBrush`, and one file per piece (`CostTimeline`/`CostChart`, `CostAxes`, `CostMarks`, `EventLanes`, `OverviewStrip`, `CostTable`, `CostBars`, `InteractionHeatmap`, `StatTile`). No function there exceeds 120 lines | Low | Done | [#73](https://github.com/arnadu/magi_v3/issues/73) |
| `packages/cockpit/src/App.tsx` | 79 | **Decomposed (#73, 2026-10-19).** `App` is the sign-in and view gate; `app-hooks.ts` (auth, view, mission status stream, mission name), `Header.tsx`, `AgentErrorBanner.tsx`, `LoadingView.tsx`, `HomeView.tsx` (start page), `MissionDashboard.tsx` (one mission's panels) and a shared `TabBar.tsx`. Off the complexity exemptions | Low | Done | [#73](https://github.com/arnadu/magi_v3/issues/73) |
| `packages/agent-runtime-worker/src/agent-stats.ts` | 615 | A factory function (`createMongoAgentStatsRepository`) plus the `StatsCollector` class — already cohesive around one responsibility (turn/lifetime stats), not mixed concerns | Low | Backlog | [#36](https://github.com/arnadu/magi_v3/issues/36) |
| `packages/agent-runtime-worker/src/mission-copilot.ts` | 569 | Dominated by `buildSystemPromptTemplate` (~230 lines), almost entirely a prompt-text template literal, not branching logic — long due to prose content, same category as `copilot.yaml`'s own system prompt | Low | Backlog | [#36](https://github.com/arnadu/magi_v3/issues/36) |
| `packages/agent-runtime-worker/src/tools.ts` | 566 | 18 top-level exports — flat tool-definition dispatch, matching the established one-file-many-tools pattern used elsewhere in this package | Low | Backlog | [#36](https://github.com/arnadu/magi_v3/issues/36) |
| `packages/cockpit/src/ConfigPanel.tsx` | 543 | Small number of exports (`availableSkills`, `MentalMapEditor`, `ConfigPanel`), reasonable for a panel with an embedded editor sub-component | Low | Backlog | [#36](https://github.com/arnadu/magi_v3/issues/36) |

Line counts as of 2026-09-23 (Sprint 28g close-out `/code-structure-review`), except `monitor-server.ts`
and `daemon.ts` (re-measured 2026-09-15 post-decomposition, unchanged since). Re-measure at each
`/code-structure-review` pass — this table is a snapshot, not a live query. Test files are
deliberately excluded from this inventory (several crossed 500+ lines this sprint — e.g.
`resource-upgrade.unit.test.ts` at 843 — but a large, thorough test file is not the same
maintainability concern as a large source file).

## Decomposition risk key

- **Low** — concerns are already siloed (independent sections/closures sharing minimal state); a
  near-mechanical extraction.
- **Medium** — most of the file is already well-factored; a handful of individual functions still
  need extraction.
- **High** — a genuine god-function with sequential phases and shared mutable state; needs
  characterization test coverage before decomposition, not just a mechanical move.
- **Unknown** — flagged by size alone; not yet read closely enough to assess.

## Recently fixed

*(none yet — this document was created 2026-08-12)*

### Cockpit and BrowseWeb decompositions (2026-10-19, #73)

`DraftEditor.tsx` (hooks `use-draft-state.ts`, `use-draft-save-launch.ts`; `DraftAgentForm.tsx`),
`CopilotPanel.tsx` (`copilot/`: `copilot-entries.ts`, `use-copilot-stream.ts`, `CopilotEntryView`,
`CopilotModelPicker`), `ConfigPanel.tsx` (`ConfigMissionFields`, `ConfigAgentForm`,
`CopilotConfigView`, `MentalMapSection`, `MentalMapEditor`, `use-mission-config-editor.ts`),
`ConversationsPanel.tsx` (`conversations/`: `threads.ts`, `use-conversations.ts`,
`use-rail-width.ts`, `ThreadList`, `ConversationView`, `ComposeBar`) and
`tools/browse-web.ts` (`browse-web-session.ts`: model mapping, session log, `BrowserSession`)
no longer have a function over 120 lines, except the panels' allowlisted remainders. Pure logic
pulled out of components is unit-tested and counts toward the cockpit coverage floor.

