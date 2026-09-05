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
| `packages/agent-runtime-worker/src/monitor-server.ts` | 1876 | HTTP routing + auth + SSE + raw Mongo queries + file/git operations, almost entirely concentrated in one method: `handleRequest` (~725 lines, ~34 routes as a single if/else chain) | High | Planned — Sprint 28c | [#32](https://github.com/arnadu/magi_v3/issues/32) |
| `packages/agent-runtime-worker/src/daemon.ts` | 1455 | Full process bootstrap in `main()` (~745 lines): env parsing, Mongo/repo construction, workspace provisioning, signal handling, monitor/tool-server startup, job-runner startup, mailbox watching, orchestration launch — ~30 closure-captured locals threaded through sequentially | High | Planned — Sprint 28c | [#33](https://github.com/arnadu/magi_v3/issues/33) |
| `packages/agent-runtime-worker/src/mission-copilot-tools.ts` | 1263 | Already partitioned into 7 labeled "Family" sections (ADR-0016) sharing 3 small helper closures; no individual tool body exceeds ~40 lines | Low | Backlog | [#34](https://github.com/arnadu/magi_v3/issues/34) |
| `packages/control-plane/src/missions.ts` | 1387 | Policy/persistence already extracted into separately exported, reused functions (`readLimits`, `writeMissionCap`, `writeAgentLimits`); only the router-registration function and a few individual handlers (`/stats`, `POST /`, `PUT /:id/config`, ~80–120 lines each) remain large | Medium | Backlog | [#35](https://github.com/arnadu/magi_v3/issues/35) |
| `packages/agent-runtime-worker/src/agent-runner.ts` | 972 | Not yet characterized | Unknown | Backlog — needs triage | [#36](https://github.com/arnadu/magi_v3/issues/36) |
| `packages/agent-runtime-worker/src/document-processor.ts` | 887 | Not yet characterized | Unknown | Backlog — needs triage | [#36](https://github.com/arnadu/magi_v3/issues/36) |
| `packages/control-plane/src/copilot-router.ts` | 799 | Not yet characterized | Unknown | Backlog — needs triage | [#36](https://github.com/arnadu/magi_v3/issues/36) |
| `packages/control-plane/src/copilot-tools.ts` | 761 | Not yet characterized | Unknown | Backlog — needs triage | [#36](https://github.com/arnadu/magi_v3/issues/36) |

Line counts as of 2026-08-12 (`find packages -name "*.ts" -o -name "*.tsx" | xargs wc -l`, excluding
`node_modules`/`dist`/tests). Re-measure at each `/code-structure-review` pass — this table is a
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
