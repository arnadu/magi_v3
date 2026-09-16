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
| `packages/agent-runtime-worker/src/monitor-server.ts` | 1333 | `handleRequest` decomposed 2026-09-14 into a 36-line auth-gate + route-table dispatch; all 34 routes now live in `monitor-routes/*.ts` (15 files, one per cluster, factory functions taking an explicit `deps` object). Remaining bulk is independent private helpers (`serveFilePath`, `handleUpload`, `handleDownload`, `statusPayload`, `watchMailbox`, etc.) and shared constants/types — no single god-function left | Low | Done — `handleRequest` decomposition complete; remaining file is many small independent pieces, not a decomposition candidate per CLAUDE.md's Code Structure guidance | [#32](https://github.com/arnadu/magi_v3/issues/32) |
| `packages/agent-runtime-worker/src/daemon.ts` | 781 | `main()` decomposed 2026-09-15 from ~792 lines to ~213: a `BootContext` threaded by value, with 19 phases (env parsing, Mongo connect, team-config load, agent-identity provisioning, repo/workspace construction, monitor/tool-server startup, job-runner start, mail-waiter, mission-copilot-tools, orchestration callbacks, etc.) each extracted into `daemon-boot/*.ts` (19 files) as `Pick<BootContext,...>`-typed functions, merged into `ctx` via `Object.assign`. `main()` itself is now a top-to-bottom sequence of named phase calls. Remaining in this file: `main()`'s own process-lifecycle triad (unchanged per design — see the plan), plus `ensureAgentUsers`-adjacent runtime functions (`runPendingJobs`, `startJobRunner`, `logMemoryUsage`, `dataKeysEnv`, `cancelBackgroundJob`) that are ongoing runtime concerns, not boot phases | Low | Done — all 19 planned boot phases extracted with unit test coverage; verified against `daemon-job.integration.test.ts`'s real end-to-end daemon boot after every risk-bearing step | [#33](https://github.com/arnadu/magi_v3/issues/33) |
| `packages/agent-runtime-worker/src/mission-copilot-tools.ts` | 1263 | Already partitioned into 7 labeled "Family" sections (ADR-0016) sharing 3 small helper closures; no individual tool body exceeds ~40 lines | Low | Backlog | [#34](https://github.com/arnadu/magi_v3/issues/34) |
| `packages/control-plane/src/missions.ts` | 1387 | Policy/persistence already extracted into separately exported, reused functions (`readLimits`, `writeMissionCap`, `writeAgentLimits`); only the router-registration function and a few individual handlers (`/stats`, `POST /`, `PUT /:id/config`, ~80–120 lines each) remain large | Medium | Backlog | [#35](https://github.com/arnadu/magi_v3/issues/35) |
| `packages/agent-runtime-worker/src/agent-runner.ts` | 972 | Not yet characterized | Unknown | Backlog — needs triage | [#36](https://github.com/arnadu/magi_v3/issues/36) |
| `packages/agent-runtime-worker/src/document-processor.ts` | 887 | Not yet characterized | Unknown | Backlog — needs triage | [#36](https://github.com/arnadu/magi_v3/issues/36) |
| `packages/control-plane/src/copilot-router.ts` | 799 | Not yet characterized | Unknown | Backlog — needs triage | [#36](https://github.com/arnadu/magi_v3/issues/36) |
| `packages/control-plane/src/copilot-tools.ts` | 761 | Not yet characterized | Unknown | Backlog — needs triage | [#36](https://github.com/arnadu/magi_v3/issues/36) |

Line counts as of 2026-08-12, except `monitor-server.ts` and `daemon.ts` (both re-measured
2026-09-15 post-decomposition). Re-measure at each `/code-structure-review` pass — this table is a
snapshot, not a live query.

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
