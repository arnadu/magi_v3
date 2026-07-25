# ADR-0021 — Structured mission/template config storage, YAML confined to disk

**Status**: Accepted
**Sprint**: 26c (sequenced before the objectives Mongo migration, ADR-0019)
**Date**: 2026-07-23 (revised — see "Revision note" at the end; supersedes the 2026-07-22 draft,
which described the change rather than the destination)

---

## Context

`missions` and `templates` both store their configuration as `teamConfigYaml: string` — a
serialized YAML document validated by `parseTeamConfig()` and, since ADR-0018, read fresh from
Mongo on every limit check. This has real, compounding costs, found while designing the
objectives migration (ADR-0019):

- **Two redundant config-loading mechanisms coexist.** At machine creation, `fly-machines.ts`
  bakes the whole `teamConfigYaml` into a `TEAM_CONFIG_YAML` env var; the daemon writes it to a
  local file and loads it via `loadTeamConfig(path)` at boot. Separately,
  `MissionConfigRepository.readTeamConfig()` (ADR-0018) does a *live* Mongo read of the same field
  for post-boot freshness checks. The daemon already receives `MISSION_ID` as a plain env var and
  connects to Mongo immediately after boot — nothing structurally requires the baked-file path;
  it predates the live-refresh mechanism.
- **Every edit requires reconstructing or surgically patching a whole text document.**
  `SaveMissionConfig` (mission copilot) and the cockpit's `PUT /:id/config` require a complete,
  valid `teamConfigYaml` string to change anything — changing one agent's system prompt means
  correctly reconstructing the entire document's YAML syntax on an LLM tool call. Limits
  (ADR-0018) already needed a bespoke surgical-patch library (`yaml-patch.ts`) just to let the
  cockpit's Limits panel change one field safely.
- **The one thing that patch library protects — hand-written comments, edited through a raw text
  editor — belongs to a UI surface already scheduled for removal.** The only place a human can
  hand-edit this YAML with comments today is the legacy `packages/control-plane/public/index.html`
  dashboard. The cockpit SPA has no YAML editor at all, and `index.html` is slated for retirement
  in Sprint 27 — once it's gone, nothing left in the system ever hand-writes a comment into one of
  these documents.
- **The template-editing surface this exposed turned out to be the actual problem, not just its
  storage format.** `templates.ts`'s versioned CRUD, `save_template`/`restore_template_version`
  (a ~70-line three-way `teamFiles` merge) and `snapshotSharedDir` (an ~80-line function that
  HTTP-walks a *running* mission's file tree to harvest it into a template version) had, at the
  time of this review, **zero test coverage** of any kind — not even indirect. It is also a
  genuinely separate product capability (reusable, operator/copilot-authored, versioned templates)
  from what this ADR is actually about. Migrating that surface's storage format would have
  preserved its complexity and its risk; the right call was to not carry it forward for the MVP.
- **The one thing YAML is genuinely good for has nothing to do with where the live config
  lives.** Every team config file, without exception — even the smallest local test fixture,
  `config/teams/test/word-count.yaml` at 80 lines — embeds substantial multi-paragraph
  `systemPrompt`/`initialMentalMap` text via YAML's block-scalar (`|`) syntax, a real authoring
  win over JSON's escaped-newline strings. That's an argument for keeping YAML as a **hand-authoring
  format**, not for keeping it as a **storage or wire format**.

---

## Decision — target state

This section describes the finished architecture directly, not as a diff from today.

### Templates — immutable, disk-only, no database presence

A template is a named, hand-authored starting point for a mission: `config/teams/{id}.yaml`.
Templates are **read-only at runtime and never stored in a database**. The control plane parses
every `config/teams/*.yaml` file (excluding `copilot.yaml` and anything under `test/`) exactly
once, at process startup, into an in-memory `Map<templateId, TeamConfig>`. `templateId` is the
filename stem. Changing a template means editing the file and redeploying — there is no template
edit, version, or rollback capability anywhere in the running system. An operator or copilot can
**read** a template (to pick a starting point) but cannot create or modify one without a developer
committing a file change.

**Explicitly out of scope, by design**: template CRUD, version history, snapshotting a running
mission's files back into a template. Cut deliberately (see Context) — reversible later without
undoing anything else here, since nothing else in this design depends on templates being mutable.

### Missions — structured documents, current-state + append-only revision history

A mission's configuration lives entirely as structured fields on its `missions` document — never
as serialized text of any kind, at any point in its lifecycle.

```ts
// missions collection — one document per mission
interface MissionDoc {
  missionId: string;
  userId: string;
  name: string;
  teamConfig: string;              // which template this was launched from (provenance only)

  mission: {
    id: string;                    // == missionId
    name: string;
    model?: string;                // omitted → env var default
    visionModel?: string;          // omitted → env var default
    timezone?: string;             // omitted → UTC-only in prompts
    maxCostUsd?: number;           // omitted → no mission-wide cap
  };
  agents: AgentConfig[];
  missionCopilotLimits?: Limits;   // omitted → built-in soft defaults only

  teamFiles?: Array<{ path: string; content: string }>;

  machineId?: string;              // present once status is "running"/"suspended"
  privateIp?: string;
  volumeId?: string;
  status: "provisioning" | "running" | "suspended" | "destroyed" | "error";
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface AgentConfig {
  id: string;
  name: string;                    // always explicit — see "Required-field rule" below
  role: string;                    // always explicit
  supervisor: string;
  systemPrompt: string;
  initialMentalMap: string;
  limits?: Limits;                 // omitted → built-in soft defaults only
  linuxUser?: string;              // omitted in production → derived from id at OS-user creation
  active?: boolean;                // omitted → true
  disabledSkills?: string[];
  disabledTools?: string[];
}

interface Limits {
  maxLlmCallsPerTurn?: number;
  maxCostPerTurnUsd?: number;
  maxLifetimeCostUsd?: number;
  warnLlmCallsPerTurn?: number;
  warnPeakContextTokens?: number;
  warnToolErrorsPerTurn?: number;
  warnConsecutiveZeroOutputTurns?: number;
}
```

**Required-field rule**: a field is optional if and only if `undefined` is itself meaningful
information ("use the system default"). `AgentConfig.name`/`role` do not qualify — today's system
falls back to `id` for a blank name/role, a real value, not an absence; that fallback is resolved
exactly once, when a `TeamConfig` is produced (see "Parsing," below), so it is always present in
every stored document and every tool payload. `Limits` fields and `mission.model`/`visionModel`/
`timezone`/`maxCostUsd` remain optional — their absence is a genuine, distinct system state (no
cap, no override), not missing data.

**Not required now, explicit fast-follow**: `machineId`/`privateIp`/`volumeId` are shown above as
independently optional, but are actually state-conditional on `status` (absent only during
`"provisioning"`). The correct expression is a discriminated union keyed on `status`. Deferred
because it touches every `MissionDoc` construction/read site in the codebase, not just config —
tracked separately, out of scope here.

### Revision history — current-state document + append-only log, not event-sourcing

Mission config is read on a hot path: every daemon boot, and every single LLM call's limit check.
Full event-sourcing (fold-to-current-state on every read) is the wrong shape for that access
pattern. Instead:

```ts
// missionConfigRevisions — append-only, one document per edit, never read on the hot path
interface MissionConfigRevisionDoc {
  missionId: string;
  at: Date;
  by: string;   // "user" | an agentId | "copilot" | "migration"
  config: { mission: MissionDoc["mission"]; agents: AgentConfig[]; missionCopilotLimits?: Limits };
}
```

`missions` holds current state only, updated via `$set`. `missionConfigRevisions` is a pure
append-only sequence of snapshots — each document is the resulting state *after* one edit, never
updated once written. The ordered sequence of documents for a `missionId` **is** the complete
history; there is no "before" field, deliberately — a before/after pair per document would
duplicate every edit's state twice (edit N's "after" is identical to edit N+1's "before") and,
worse, would look identical in shape to something an upsert-per-mission implementation might
produce by mistake, which is exactly the "only the last value survives" failure this design must
rule out by construction, not by convention. "What changed in one specific edit" — a rare,
history-browsing-only question — is answered by diffing that document's `config` against the
previous document's on read, not by carrying a redundant copy on every write. Written by every
mutating path through one shared helper (mirroring this codebase's `AnomalyRecorder`/ADR-0020
shape — one write-path helper, reused by every mutating call site). This gives full audit history
and manual rollback capability (re-insert an old `config` as a new edit) without taxing the hot
read path. No UI or tool for browsing/rolling back is specified here — this is the write-side
foundation only; building that surface is a separate, later decision.

This is a deliberately different answer than objectives (tasks/KPI values/cost/the objective tree
itself) get under the ADR-0019 migration — objectives are read once per turn, cool enough that
full event-sourcing as the primary model is the right fit there. Two different data shapes for
two different access patterns, not one universal rule; see ADR-0019 for that side.

### Parsing — one validator, two entry points

```ts
// agent-config package
function parseTeamConfig(obj: unknown): TeamConfig;         // core: env-var expansion, Zod
                                                              // validation, reserved-id check,
                                                              // name/role defaulting
function parseTeamConfigYaml(yamlText: string): TeamConfig; // thin wrapper: yaml.parse() then
                                                              // delegates to parseTeamConfig()
```

`parseTeamConfigYaml` exists for exactly one purpose: converting a `config/teams/*.yaml` file into
a `TeamConfig` object. It is called in exactly two places in the entire system — the in-memory
template loader (control-plane startup) and `loadTeamConfig()` (local CLI/test-harness file
loading, e.g. `TEAM_CONFIG=path npm run cli`). It is never called against anything stored in
MongoDB. Every other caller — every route, every tool, the daemon's own boot sequence — calls
`parseTeamConfig(obj)` directly against an already-structured JS object.

### Data flow, end to end

1. `config/teams/*.yaml` → parsed once (`parseTeamConfigYaml`) at control-plane startup → in-memory
   `Map<templateId, TeamConfig>`.
2. `POST /api/missions` → resolves a `TeamConfig` from either that map or an inline structured JSON
   payload (never inline YAML) → clones `mission`/`agents`/`missionCopilotLimits` with `missionId`
   patched in via object spread → writes those fields directly into a new `MissionDoc`. If a named
   template doesn't exist, this is an explicit 404/400 — never a silent fallback to a generic
   default (a deliberate correctness fix over today's behavior, not an incidental side effect).
3. The daemon boots by reading its own `MissionDoc` from `missions` directly, keyed by the
   `MISSION_ID` env var (already required at machine creation for other reasons) — no config of
   any kind is baked into machine creation.
4. Every edit to a running mission — cockpit, `SaveMissionConfig` (mission copilot),
   `save_session_config` (control-plane copilot) — reads current `mission`/`agents`/
   `missionCopilotLimits`, applies a partial patch (omitted top-level fields preserve current
   state; `agents` upserted by `id`), writes the new state with `$set`, and inserts one
   `missionConfigRevisions` document. Resume re-provisions the machine but boot behavior is
   identical to step 3 — it re-reads current Mongo state, so an edit made while suspended is
   picked up automatically, with no separate "push config on resume" mechanism needed.

### Deleted entirely

`yaml-patch.ts` and `patchAgentLimits`/`patchMissionCap` — replaced by direct `$set` updates.
`TEAM_CONFIG_YAML` env var and the volume-written `team.yaml` at machine creation.
`templates.ts`'s versioned CRUD, `save_template`/`restore_template_version`, `snapshotSharedDir`,
`ListTemplateVersions` — replaced by nothing; the capability is cut, not relocated (see Templates,
above).

### Non-goals (explicit, so scope doesn't silently drift back in)

- Template editing, versioning, or snapshotting a mission's files into a template.
- Reading or rolling back a `missionConfigRevisions` entry through any UI or tool — write-side
  only in this ADR.
- The `MissionDoc` discriminated-union tightening on `status`.
- Anything about objectives/tasks/KPIs — ADR-0019, sequenced after this one lands.

---

## Consequences

- **Every `parseTeamConfig(mission.teamConfigYaml)` call site changes** — `mission-config.ts`,
  `missions.ts`, `templates.ts`, `daemon.ts`, `fly-machines.ts`. Each change is mechanical (read
  structured fields instead of a string field), but touches the production boot sequence, so
  verification needs a real machine cycle, not just unit tests, before this is called done.
- **Migration is low-risk but not automatic**: every existing `teamConfigYaml` in Mongo already
  passes `parseTeamConfig` today (or the mission wouldn't run), so a one-time, idempotent,
  committed script — parse existing YAML, write the structured fields, pure Mongo-to-Mongo —
  covers every live mission. Run manually, once, before the write/boot cutover deploys.
  Templates need no migration at all (they never move to Mongo); the old `templates` Mongo
  collection is simply abandoned, not actively dropped.
- **The objectives migration's open "how does a template seed this" question is answered by this
  ADR, not deferred further** — sequenced before ADR-0019's implementation for exactly that
  reason.
- **LLM tool-call reliability improves for the mission copilot**: `SaveMissionConfig` no longer
  requires reconstructing an entire valid document to change one field.
- **The control-plane copilot's write surface narrows** — `save_template`/
  `restore_template_version` are removed, not ported, reducing its blast radius.
- **No change to the local dev/test-harness workflow** — `TEAM_CONFIG=path npm run cli` is
  untouched, since that path never read `teamConfigYaml` from Mongo to begin with.
- **A new collection, `missionConfigRevisions`, exists purely for future auditability/rollback** —
  it is not read by anything in this ADR's scope; its value is realized only when a later piece of
  work builds a UI or tool against it.

---

## Related

- [ADR-0017](0017-cost-tracking-single-source-fresh-reads.md),
  [ADR-0018](0018-limit-configuration-single-source-fresh-reads.md) — the same "read the real,
  current source, don't cache/duplicate it" principle applied to metrics and configuration
  respectively; this ADR applies the same principle to the *storage shape* of configuration itself
- [ADR-0019](0019-objectives-mongodb-migration.md) — sequenced after this ADR; its template-seeding
  design depends on templates being structured documents; its own revision-history answer
  (event-sourcing, not a separate revisions collection) is the deliberate contrast documented above
- [ADR-0020](0020-copilot-wake-up-anomaly-log.md) — `AnomalyRecorder`'s "one shared write-path
  helper, reused by every mutating call site" shape is reused here for `missionConfigRevisions`
- `packages/agent-config/src/loader.ts` — `parseTeamConfig`/`parseTeamConfigYaml` split,
  `loadTeamConfig` (unchanged, local-file path only)
- `packages/control-plane/src/missions.ts`, `packages/control-plane/src/templates.ts` — write
  routes move to structured JSON; `templates.ts` shrinks to two read-only routes
- `packages/control-plane/src/fly-machines.ts` — machine provisioning drops baked config entirely
- `packages/agent-runtime-worker/src/daemon.ts` — boot reads structured config directly from Mongo

---

## Revision note

This ADR was rewritten the day after its initial acceptance. The original version documented the
change as a narrative (what's wrong today, what to do about it) without a standalone description
of the destination architecture — useful for understanding the motivation, but not sufficient as
something to implement against or verify completeness against. Implementation planning surfaced,
in order: a real correctness landmine (write-cutover and boot-cutover cannot ship as separate
deploys — resume/creation silently fall back to generic defaults if config-writes and config-reads
disagree about which field is current), the decision to cut template editing entirely rather than
migrate it (found to have zero test coverage and to be a separate product capability), required-
field tightening for `AgentConfig.name`/`role`, and the `missionConfigRevisions` design for
rollback. All of that is folded into the target-state description above rather than left as a
trail of incremental patches; the original Context's evidence (why this was worth doing at all) is
preserved, condensed, above.
