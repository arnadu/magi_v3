# ADR-0019 — Migrate objectives storage from Fly-volume files to MongoDB (DRAFT)

**Status**: Proposed — not yet accepted or scheduled. Recorded now so the design reasoning
survives to whichever sprint picks this up. Tracked in
[GitHub issue #23](https://github.com/arnadu/magi_v3/issues/23).
**Sprint**: Recommended Sprint 26c (see "Recommended timing" below) — not committed.
**Date**: 2026-07-21

---

## Context

Objectives (`sharedDir/objectives/{goals.json, tasks.jsonl, kpis.jsonl}` — the objective tree,
task-update events, and KPI-value events) are currently stored as files on each mission's Fly
volume, git-versioned via the existing git-commit-on-sleep mechanism, updated by agents through
Bash-invoked shell scripts (`packages/skills/objectives/scripts/*.sh`, pure `fs.appendFileSync`,
by design "no MongoDB collections" — the original Sprint 26a intent).

MongoDB's `missions.teamFiles` field *also* holds a copy of these same files — originally just the
generic mechanism used to seed a fresh mission's workspace from its template. Nothing keeps this
Mongo copy in sync with the volume after first provisioning: agents' skill-script updates and the
copilot's own direct edits to `goals.json` only ever touch the volume. The only way MongoDB's copy
updates is an explicit `SaveMissionConfig` call, made manually, with no trigger forcing it after
every real change.

This caused a real incident on `gold-digest-v2-20260628-1451` (2026-07-21): `WorkspaceManager
.provision()` — which reruns on every resume, since resume deletes and recreates the machine —
unconditionally overwrote the volume's evolved `objectives/*` with MongoDB's stale snapshot on
every resume, silently rolling back real progress. Root-caused via direct git-log inspection of
the mission's own workspace (not the mission copilot's self-report, which correctly identified the
*symptom* — agents "overwriting" objectives — but misattributed the *mechanism*; the actual
culprit turned out to be the resume-time provisioning step, not any agent's direct write).

An interim fix shipped same-day (this ADR's companion commit): `copyTeamFilesToSharedDir` now
seeds `objectives/*` only when missing, never overwrites an existing file there. This closes the
acute bug but leaves the underlying two-copy architecture in place — MongoDB's `teamFiles.
objectives` becomes a permanently-inert snapshot, still present, still capable of misleading a
future feature that assumes it's current.

A second, independent, already-real gap surfaced while investigating: the cockpit's
`ObjectivesPanel` proxies through the mission's own MonitorServer (`cockpit/src/data.ts`) and is
**completely blank while a mission is suspended** — objectives have none of the
"readable/writable regardless of mission running state" property ADR-0018 already gave cost/limits.

---

## Decision (proposed)

Move objectives fully into MongoDB, removing the file-based copy as a *second* source of truth
(not just patching the sync gap):

- **New collections**, mirroring existing patterns rather than inventing new ones:
  - An append-only event collection for task/KPI updates — the direct MongoDB equivalent of
    today's `tasks.jsonl`/`kpis.jsonl` ("last write wins on read," per `task-update.sh`'s own
    comment), structurally identical in spirit to `llmCallLog` (one doc per event, queryable).
  - A current-state document per mission for the objective tree (`goals.json`'s equivalent),
    updated via `$set`/`$inc`-style writes — the same shape as `missionStats`.
- **Agent-facing tools, not skill scripts.** This isn't a style preference — agent Bash subprocess
  children deliberately receive no secrets, including no `MONGODB_URI` (the existing isolation
  model: "child process receives only `PATH` and `HOME`"). A Bash script cannot write to MongoDB.
  Moving storage to Mongo *requires* replacing `task-update.sh`/`record-kpi.sh`/`task-add.sh`/
  `allocate.sh` with real `MagiTool` implementations (Zod-validated parameters, called in-process
  by the orchestrator, which does hold the connection) — analogous to `createFileTools`/
  `createMailboxTools`.
- **`objectives/agent-view.ts`'s mental-map rendering** (`renderMyObjectives`, injected into every
  agent's "Your objectives" section each turn) switches from reading the local file to querying
  the new repository.
- **Cockpit's `ObjectivesPanel`** switches from the monitor-proxy fetch to a direct control-plane
  route reading Mongo — same pattern `readLimits()` already established, works regardless of
  mission running state.

## Alternatives considered

**Keep the interim fix as the permanent design** (file+volume, with the resume-overwrite bug
patched). Rejected as the long-term answer, not as a stopgap — it's the right immediate fix (small,
low-risk, closes the acute incident) but leaves a structurally two-copy system in place: MongoDB's
`teamFiles.objectives` remains an inert-but-present snapshot, and the "suspended mission = blank
ObjectivesPanel" gap is untouched. This is exactly the pattern ADR-0017/0018 removed elsewhere in
the system (a second copy that *can* drift, papered over, rather than removed) — objectives would
be the one remaining place it still exists by design.

## Costs, stated plainly

- New collections + repository + real TypeScript tools (Zod schemas registered per-agent) —
  genuine multi-day scope, not a small patch.
- **Data migration required** for every mission with live file-based objectives, not just the one
  that triggered this — must not lose in-flight state.
- `SKILL.md` → tool descriptions rewrite; agents currently taught via a doc block, would need the
  tool-calling interface instead.
- Marginal per-call token cost: 4-5 more tool schemas in every regular agent's system prompt
  (bounded, cache-amortized against the size of the existing Tier A/B tool library — not a real
  blocker, but nonzero and worth tracking if it matters at scale).
- A weaker failure mode than today's: a task-status update becomes a network call that can fail on
  a Mongo hiccup, versus always-succeeds local file append today. Judged minor in practice — a tool
  call already implies an LLM round-trip is underway, so the added write is negligible next to that
  latency (the same reasoning already validated for cost/limit checks in ADR-0017/0018) — but
  worth naming rather than hand-waving.
- Git-versioned audit trail (`git log`/`git show` on `goals.json`, which is literally how this
  incident was diagnosed) is lost as-is unless deliberately rebuilt as the append-only events
  collection described above — not free, but not hard either, since the event-log shape already
  exists in the current design; it just needs to target Mongo instead of a file.

## Recommended timing

**Sprint 26c**, a new sprint scoped as "close out the 24–26 alignment-infrastructure arc" —
not Sprint 26b itself (already large: cockpit SPA, mission-copilot rollout, Limits panel,
ADR-0017, ADR-0018, and this incident's interim fix; the acute risk is already closed by the
interim fix, so there's no urgency forcing the full migration into 26b), and deliberately **not**
Sprint 27. Sprint 27 ("launch hardening": G-5 alerting, onboarding flow, usage dashboard, security
review, `index.html`→cockpit UI consolidation) is a coherent bundle about *external* launch
readiness — a genuinely different kind of work than an internal data-model migration, and folding
this into it would dilute that focus and likely get deprioritized against the other four items
anyway.

The roadmap's own "Design Notes" section frames Sprints 24–26 as one arc: "equip the copilot and
operator with the instruments needed to keep agents aligned with mission intent." Objectives are
that alignment infrastructure — arguably the central piece of it (`SKILL.md` calls the store
explicitly "the shared source of truth the operator watches"). Finishing its single-source-of-truth
hardening is the natural close of that arc, not a launch-readiness concern. Sprint 26c bundles this
with 26b's other leftover items (Files panel direct-edit, cockpit-vs-chat mode auto-selection,
copilot wake-up attribution + persisted anomaly/limit-breach logging) for exactly that reason — all
of it is "finish what 24–26 started," not "get ready to launch." It should not be deferred
indefinitely either way: the pattern has now caused one real incident, and the interim fix is
explicitly described in its own code comment as a narrow patch, not the intended end state.

---

## Related

- [ADR-0017](0017-cost-tracking-single-source-fresh-reads.md), [ADR-0018](0018-limit-configuration-single-source-fresh-reads.md) — the same "single source of truth, remove the second copy rather than patch it" principle, applied earlier this sprint to cost metrics and limit configuration
- [GitHub issue #23](https://github.com/arnadu/magi_v3/issues/23)
- `docs/implementation-history.md` — Sprint 26b, incident narrative and interim fix
- `packages/agent-runtime-worker/src/workspace-manager.ts` — `copyTeamFilesToSharedDir` (interim fix)
- `packages/skills/objectives/` — current skill/scripts to be replaced
- `packages/agent-runtime-worker/src/objectives/` — `agent-view.ts`, `store.ts`, `attribution.ts`
