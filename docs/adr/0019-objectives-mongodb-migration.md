# ADR-0019 — Migrate objectives storage from Fly-volume files to MongoDB

**Status**: Accepted — implemented Sprint 26c. Tracked in
[GitHub issue #23](https://github.com/arnadu/magi_v3/issues/23).
**Sprint**: 26c
**Date**: 2026-07-21 (proposed); implemented 2026-07-26

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

## Decision (as implemented)

Objectives moved fully into MongoDB, removing the file-based copy as a *second* source of truth
(not just patching the sync gap):

- **Two new collections**, mirroring existing patterns rather than inventing new ones:
  - `objectivesEvents` — one append-only doc per event (`{missionId, kind: "task"|"kpi"|"cost"|"alloc", ...event}`,
    event fields spread directly onto the doc so `at`/`by` are top-level and indexable; indexed
    `{missionId:1, kind:1, at:1}`). The direct MongoDB equivalent of `tasks.jsonl`/`kpis.jsonl`/
    `cost.jsonl`/`alloc.jsonl` combined, structurally identical in spirit to `llmCallLog`. This
    collection **is** the git-audit-trail replacement this ADR's "Costs" section flagged as a
    real loss — no separate mechanism was needed.
  - `objectivesGoals` — one current-state doc per mission (`{missionId, objectives, updatedAt, updatedBy}`),
    the `goals.json` equivalent. Overwritten (not merged) on write, same contract the file-based
    `saveGoals` had. Its mere existence for a `missionId` doubles as the "already migrated" marker
    the boot-time migration (below) checks.
  - New `ObjectivesRepository` interface + `createMongoObjectivesRepository(db)`
    (`objectives/repository.ts`), mirroring `MissionConfigRepository`'s shape. The existing pure
    fold engine (`foldStore` in `objectives/store.ts`) needed **zero changes** — it already took
    plain event arrays in and returned a `FoldedTree`, with no knowledge of where those arrays
    came from. Only the I/O layer was replaced.
- **Agent-facing tools, not skill scripts.** Required, not a style preference — agent Bash
  subprocess children deliberately receive no secrets, including no `MONGODB_URI`. `task-add.sh`/
  `task-update.sh`/`record-kpi.sh`/`allocate.sh` were deleted and replaced by `AddTask`/`UpdateTask`/
  `RecordKpi`/`Allocate` `MagiTool`s (`objectives/tools.ts`), added to every agent's tool set
  alongside `createFileTools`/`createMailboxTools`, filterable via each agent's existing
  `disabledTools`. `packages/skills/objectives/SKILL.md` was kept (rewritten to teach tool calls
  instead of Bash invocations) rather than deleted — the same shape as the pre-existing
  `inter-agent-comms` skill, which already coexists with built-in mailbox tools the same way.
- **Goal-tree editing got a proper replacement, not a silent capability loss.** The mission
  copilot previously edited `goals.json` directly via `WriteFile` (taught in
  `mission-leadership/SKILL.md`). New `EditObjectiveTree` tool (copilot-only, in
  `mission-copilot-tools.ts`, beside the pre-existing `ReadMissionObjectives`) takes a full
  replacement `objectives` array (caller reads current state first, same caller-merges contract
  as `SaveMissionConfig`). A side benefit: since the tree is no longer a file, no other agent can
  touch it at all anymore (previously blocked only by prompt convention, not technically).
- **`objectives/agent-view.ts`'s mental-map rendering** (`renderMyObjectives`) needed **no
  changes** — already pure (`FoldedTree` in, HTML out).
- **Cockpit's `ObjectivesPanel`** switched from the monitor-proxy fetch (`/missions/:id/objectives`,
  gated on `status === "running"` by `proxy.ts`) to a new, non-proxied control-plane route
  (`GET /api/missions/:id/objectives` in `missions.ts`, mirroring `readLimits`'s shape) — works
  regardless of mission running state, closing the gap this ADR named directly.
- **The control-plane copilot's `ReviewObjectives`/`AssessKpi`** switched from `monitorFetch`/
  `monitorPost` (required `mission.privateIp`, i.e. the mission running) to calling
  `createMongoObjectivesRepository(db)` directly — both now work on a suspended mission too, a
  real capability gain that fell out of the migration rather than requiring separate work.
  `monitor-server.ts`'s `GET /objectives`/`POST /objectives/kpi` HTTP routes were deleted entirely
  once nothing called them anymore (agent tools and the mission copilot's `ReadMissionObjectives`
  are already in-process; control-plane callers go direct-to-Mongo).
- **Migration of existing file-based missions** — not fully specified in the original draft below,
  worth capturing precisely: since objectives files live on a per-mission Fly volume only
  reachable when that mission's daemon is running (unlike ADR-0021's config migration, which could
  run as one standalone script against Mongo), each mission migrates **itself**, once, the next
  time it resumes. `migrateLegacyObjectivesStore()` (new `objectives/migrate-legacy-store.ts`)
  runs from `daemon.ts`'s `onWorkspaceReady`, before the mission-copilot seed step: no-ops if
  `hasGoalsDoc()` is already true (already migrated) or if no local `objectives/` files exist at
  all (the common case — never used objectives); otherwise imports whatever files are present into
  Mongo and always writes a goals doc (even empty) as the migrated marker. Local files are never
  deleted afterward. This same mechanism doubles as the seed path for a template shipping starting
  objectives (`config/teams/*/objectives/*`, still shipped as plain teamFiles, unchanged) — the
  files land on disk once at provision like any other teamFile, and the mission's first boot
  imports them, with no special-casing needed. This let the ADR-0019 interim fix
  (`copyTeamFilesToSharedDir`'s `isObjectivesPath` seed-if-missing branch, plus the ACL-grant
  block in `WorkspaceManager.provision()`) be deleted outright rather than kept alongside the new
  design — nothing ever writes to `sharedDir/objectives/*` again after provisioning, so a plain
  overwrite-on-resume is harmless.

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
  genuine multi-day scope, not a small patch. **As implemented**: mitigated substantially by the
  fold engine needing zero changes (already pure) — the real work was the I/O layer, the four
  tools, and wiring, not re-deriving the domain logic.
- **Data migration required** for every mission with live file-based objectives, not just the one
  that triggered this — must not lose in-flight state. **As implemented**: boot-time
  self-migration (see Decision above), not a standalone script; every mission with real data
  migrates itself on its next resume, in-flight state preserved, nothing deleted.
- `SKILL.md` → tool descriptions rewrite; agents currently taught via a doc block, would need the
  tool-calling interface instead. **As implemented**: done, same section structure, tool-call
  examples in place of Bash invocations.
- Marginal per-call token cost: 4-5 more tool schemas in every regular agent's system prompt
  (bounded, cache-amortized against the size of the existing Tier A/B tool library — not a real
  blocker, but nonzero and worth tracking if it matters at scale). Accepted as-is.
- A weaker failure mode than today's: a task-status update becomes a network call that can fail on
  a Mongo hiccup, versus always-succeeds local file append today. Judged minor in practice — a tool
  call already implies an LLM round-trip is underway, so the added write is negligible next to that
  latency (the same reasoning already validated for cost/limit checks in ADR-0017/0018). Accepted
  as-is; no incident reported from this class of failure as of implementation.
- Git-versioned audit trail (`git log`/`git show` on `goals.json`, which is literally how this
  incident was diagnosed) is lost as-is unless deliberately rebuilt as the append-only events
  collection described above. **As implemented**: `objectivesEvents` is exactly that replacement —
  queryable by `missionId`/`kind`/`at`, no separate mechanism needed.

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
