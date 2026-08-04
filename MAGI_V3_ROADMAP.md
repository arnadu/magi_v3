# MAGI V3 Roadmap

## Objective

Build an autonomous multi-agent system where teams of AI agents run long-horizon missions — writing
and running code, browsing the web, processing data, coordinating with teammates, and publishing
work products. Primary use case: an equity research team producing daily market briefs, weekly
sector reports, and event-driven alerts with full citation lineage.

---

## Sprint History

| Sprint | Status | Focus | Key decisions |
|--------|--------|-------|---------------|
| 0 | ✅ Done | Architecture freeze | 6 ADRs: orchestration, agent loop, Mental Map, tool ACL, image handling, mailbox |
| 1 | ✅ Done | Inner loop | `runInnerLoop`, Bash/WriteFile/EditFile, MongoDB persistence, CLI, integration test |
| 2 | ✅ Done | Multi-agent | Zod team YAML, mailbox (PostMessage/ListMessages/ReadMessage), orchestration loop, supervisor-depth ordering |
| 3 | ✅ Done | Web tools | FetchUrl (HTML+PDF), InspectImage, SearchWeb (Brave); artifact folder model; `@path` uploads |
| 4 | ✅ Done | Identity + workspace | Linux pool users, `setfacl` ACLs, AclPolicy, WorkspaceManager, tool-executor subprocess isolation |
| 5 | ✅ Done | Agent skills | Platform skills (skill-creator, git-provenance, inter-agent-comms); skill discovery; sharedDir git init |
| 6 | ✅ Done | Persistent daemon | MongoDB Change Stream sleep, conversation persistence (ADR-0008), scheduled_messages, cli:post/cli:tail |
| 7 | ✅ Done | BrowseWeb | Stagehand/Playwright JS rendering, session persistence, SSRF blocking (ADR included in ADR-0007) |
| 8 | ✅ Done | Equity research MVP | 4-agent gold-digest team, schedule-task skill, daily brief + performance tracker |
| 9 | ✅ Done | Context management | Session-boundary compaction, reflection (ADR-0009), llmCallLog, cli:usage |
| 10 | ✅ Done | Research tool | Nested inner loop, isolated context, shared research index (ADR-0010) |
| 11 | ✅ Done | Dashboard UX | Sessions tree, budget pause, mental map iframe, workspace persistence, cli:reset |
| 12 | ✅ Done | Data factory | Secondary vision model, Tool IPC server (:4001), background jobs, data-factory skill (ADR-0011) |
| 13 | ✅ Done | Hardening | Security review, threat model (TB-1–TB-8), findings.md, quality gates |
| 14 | ✅ Done | Cloud infrastructure | Fly.io execution/control plane, proxy, scheduler, bootstrap.sh (ADR-0013) |
| 15 | ✅ Done | Developer onboarding | bootstrap.sh UX, .dockerignore, daemon log viewer, test config relocation, CI quality gate |
| 16 | ✅ Done | Model selection + templates | OpenRouter multi-LLM (ADR-0012), F-002 SSRF fix, agent-error SSE, MongoDB templates + provision-time injection, non-blocking resume, SHARED_DIR in subprocess env |
| 17 | ✅ Done | Concurrent dispatcher | Fire-and-forget concurrent agent dispatch (replaces sequential loop), `maxRuns`, `isAgentPaused`, F-017 verifyIsolation for OPENROUTER_API_KEY, threat model refresh |
| 18 | ✅ Done | Dashboard UI rewrite | Chat-app thread list + markdown bubbles + file browser + schedule/log/stats tabs; concurrent agent tracking; Kill button; Playbook removed |
| 19 | ✅ Done | Copilot agent | Privileged assistant in control plane: magi-copilot OS user, `runInnerLoop` wiring, 9 elevated tools (ListMissions/GetMissionStatus/ReadMissionMailbox/ReadMissionLog/ReadMissionFile/ListSchedule/ListTemplates/GetTemplate + ProposeAction confirmation model), Change Stream wakeup, execution-plane alert routing, chat panel in control plane UI |
| 20 | ✅ Done | Control plane UX (extended) | Three-column sidebar (Sprint 20 base); Unified Config Editor (structured form, CodeMirror mental map, 30s poll protection); home screen with live session cards (unread/spend/activity stats); quick launch from template; agent active toggle + add/remove agent; skill toggles (disabledSkills[]); session dual save bar + save-as-template; G-1 restart policy; `active`/`disabledSkills` schema; stats endpoint; inline YAML at launch; copilot `save_session_config` |

---

## MVP Sprints (23–27)

| Sprint | Status | Candidate focus |
|--------|--------|----------------|
| 21 | ✅ Done | Context management (in-session): ephemeral tool-result pruning (`EPHEMERAL_TOOLS`, `pruneEphemeralResults`), thinking-block stripping, mid-session prune at 160k tokens, `AnalyzeMemories` tool, extended thinking enabled on `CLAUDE_SONNET` (`reasoning: "medium"`) |
| 22 | ✅ Done | Copilot unification + config-driven tool library: copilot calls `runAgent` via `additionalTools` hook; `disabledTools` per-agent YAML; Tier A/B tool library; `LlmCallLogRepository` exported |
| 23 | ✅ Done | **Auth + multi-user**: Firebase Auth (Google OAuth); `userId` on missions; per-user mission scoping; one copilot daemon per Firebase UID (`copilot-{uid}`); `/api/usage` per-user and admin; `magi_session` cookie for new-tab auth (dashboard); org-level `FLY_API_TOKEN_CI`; 512 MB control plane VM; structured error logging + `errorMessage` in MongoDB; `MONITOR_TOKEN` HMAC auth on MonitorServer (`MONITOR_SIGNING_KEY`); fix F-008/F-009/F-016/F-019/F-020 |
| 24 | ✅ Done | **Budget hardening + alignment signals**: `StatsCollector` three-layer stats (`llmCallLog`/`agentTurnStats` upserted incrementally/`missionStats` `$inc` at turn end), three hooks `onLlmCall`/`onToolResult`/`onTurnEnd`; `LimitRule[]` framework (hard limits opt-in → abort turn; soft limits defaulted → copilot mailbox + dashboard `limit-alert` toasts); per-turn + per-agent-lifetime cost caps; OpenRouter live pricing + `costEstimated` flag (#10 Track 1); copilot `PauseAgent`/`ResumeAgent`/`SetMissionBudget` via operator-confirmed `ProposeAction` (wired `isAgentPaused`). **Deferred:** G-2 two-phase inbox ack, G-3 missed-cron replay, #10 Track 2 (exact OpenRouter cost), `NotifyUser` (dropped — copilot chat + `limit-alert` already cover it) |
| 25 | ✅ Done | **File I/O + artifact tracking**: git-commit-on-sleep (per-turn workspace checkpoint, serialized async mutex, hash in `agentTurnStats.gitCommit`, `filesWritten`/`gitChangedFiles` from `git diff`); shared `document-processor.ts` (text/CSV/image/PDF/XLSX/DOCX/ZIP, **no text truncation**, describe-now/defer image policy riding the existing `InspectImage`, first-class partial-processing markers) with **`FetchUrl` deduped onto it**; upload→process→mailbox pipeline (monitor `POST /upload`, file auto-processed + bundled with operator message, **no agent-facing ProcessFile tool**); download backend (monitor `GET /download` — single file or folder-as-zip). **Deferred:** file-content-by-commit API (`git show`) + rich download UX → Sprint 26 (trace-viewer / cockpit consumers); G-4 disk monitoring → backlog |
| 26a | ✅ Done | **Outcome-oriented cockpit (spine)**: pivot to **state + exceptions** (Endsley SA + MBO/Exception + OODA). **`objectives` platform skill**: file-based git-versioned `sharedDir/objectives/` store — objective tree (nestable, supervisor-owned) → tasks (worker-assigned, status) → KPIs (owner + `source`) + **budget** (A1/A2). **Automatic cost attribution** at turn end — `--effort` split, carry-over, `allocate` staleness fallback, supervisor overhead (B2/B2b). Daemon `#my-objectives` **mental-map bridge** every turn (B1). Copilot `ReviewObjectives`/`AssessKPI` tools (C1). File store was the single source of truth at the time — **moved to MongoDB in Sprint 26c (ADR-0019)**, this row is history, not current architecture. **Deferred (additive, per original design):** `AskUser`/`requiresResponse`/awaiting-input state — an unread message from an agent already serves as the "look at this" signal; not worth the extra state machine for the MVP |
| 26b | ✅ Done | **Monitoring + exploration**: cockpit SPA shipped in the control-plane image (E1, E1-live). **Done:** Objectives panel; Conversations rail (Messages read/unread — D1 — merged with the **bidirectional per-agent chat drawer**, the managerial↔conversational pivot); Transcripts tab (LLM-log drill-down, collapsible sub-loop boxes); Files panel (workspace tree, type-driven rendering, provenance deep-links — **read-only**); rich artifact rendering (Markdown tables, Mermaid, KaTeX); **Trace chart panel**, in three iterations — mission cost+interaction overview → cumulative cost-over-time line chart (matching the mock) → turn bounding boxes (sized by `llmCallCount`) + file/message/scheduled-wakeup/aborted-turn marker lanes, all from `agentTurnStats`/`mailbox` with no new backend instrumentation; **Trace turn click-to-drill-down** into `llmCallLog` (brush-to-zoom overview strip + click-to-drill-down from every turn box/dot/file/anomaly marker) — landed as part of Trace panel interactivity (issue #22); also a same-window, unplanned **single-source-of-truth hardening thread** — cost-tracking (ADR-0017), limit-configuration (ADR-0018), and an objectives resume-time-overwrite incident fix (interim; full fix is ADR-0019, completed in Sprint 26c). The three items originally tracked as remaining — Files panel direct-edit, cockpit-vs-chat mode auto-selection, copilot wake-up attribution + persisted anomaly logging — all shipped in Sprint 26c (see that row) |
| 26c | ✅ Done | **Close out the 24–26 alignment-infrastructure arc.** ✅ Copilot wake-up attribution + persisted anomaly log shipped (ADR-0020): new `missionAnomalies` collection, unified `AnomalyRecorder` (limit breaches, agent crashes/timeouts, LLM errors, failed jobs/schedules, unclean restarts), fixed a dead/leaky cross-user copilot-mailbox routing path found in the same pass (F-028), new shared `incident-triage` skill, "which surface" placement guidance written into `mission-leadership`/`magi-template-design`. ✅ **Structured mission/template config storage shipped (ADR-0021)**: `missions` stores `mission`/`agents`/`missionCopilotLimits` as real fields instead of a `teamConfigYaml` string (new append-only `missionConfigRevisions` log, one shared write helper for every edit path); templates became immutable, disk-only, read-only (`config/teams/*.yaml`, no more Mongo `templates` collection, no `save_template`/versioning, `seed-templates.mjs` deleted); `yaml-patch.ts` and the baked-config-at-machine-creation mechanism both deleted; daemon boots from a direct structured Mongo read via `MISSION_ID` (or `TEAM_CONFIG` for standalone local dev, unchanged); `scripts/migrate-mission-config-to-structured.mjs` migrated every pre-existing mission; the legacy `packages/control-plane/public/index.html` config editor updated to speak the new structured API at its edges (its internals stay YAML-text-based) so it isn't broken ahead of its planned Sprint 27 retirement. Found and root-fixed via the new test suite: MongoDB's default `undefined`→BSON-`null` serialization was silently breaking `missionCopilotLimits` validation on every write that didn't configure it — fixed with `ignoreUndefined: true` on the shared `MongoClient`. ✅ **Control-plane vs. mission-plane config editing scope shipped (ADR-0022)**: that same editor then corrupted a live mission's config on save (an agent's `supervisor`/`systemPrompt` silently dropped) — root cause was the client-side YAML round-trip itself plus a free-text "Advanced" escape hatch that could write fields already owned by a dedicated safe path (`mission.maxCostUsd`/`missionCopilotLimits`/`agents[].limits` — the Limits panel, ADR-0018). Fixed by deleting the round-trip and the escape hatch, not patching the field: the editor now holds cached structured JSON and edits only an allowlist (mission name/model/visionModel/timezone; per-agent name/model/active/disabledSkills/disabledTools, the last newly a first-class checkbox), with every other field passing through unmodified; `systemPrompt`/`supervisor`/`initialMentalMap`/skill-file content move to the mission copilot (`SaveMissionConfig`/`EditAgentMentalMap`), and pre-launch template customization from this dashboard is removed (launch as-is, tweak via the copilot after). See [ADR-0022](docs/adr/0022-control-plane-mission-plane-config-editing-scope.md). Directly unblocked objectives' template-seeding design. ✅ **Files panel direct-edit shipped** — the write side of the read-only-since-26b Files panel. New `POST /files/shared/edit` on `monitor-server.ts`, kept deliberately separate from the copilot's pre-existing `/files/shared/write` (that route's writes happen inside a copilot turn, already swept into that turn's own commit; an operator edit has no turn, so nothing commits or notifies it unless this route does): server-side extension allowlist (same text-type bucket the read side uses — never trusting the cockpit's own gating alone), 10 MB content cap (raised from the read side's old 200 KB, now governing both preview and editability so a truncated file can't be silently corrupted by a partial save), immediate commit through a `WorkspaceGit` instance moved up to `daemon.ts` and shared with the orchestrator (so an operator save and an agent's turn-end commit can never race each other on `.git/index.lock`), and a mailbox notification to whichever agent's turn most recently touched the file (reusing the same git-log + `agentTurnStats` join the Provenance panel already used, extracted into `resolveFileHistory()`). CodeMirror 6 (`@uiw/react-codemirror`) is the editor — one editor for every editable text type, language mode by extension, plain-text fallback otherwise, deliberately no per-type custom editor. Works only on a running mission (files live on the volume, not Mongo) — the existing proxy already 503s on suspend for free. Closes out Sprint 26c's cockpit leftovers from 26b. ✅ **Cockpit-vs-chat mode auto-selection closed — replaced by removing the control-plane copilot from the mission cockpit.** The original intent behind this item wasn't remembered by the time the sprint reached it; re-scoped to a smaller, concrete UX fix instead: the control-plane copilot (cross-mission assistant) had been folded into every mission's `ConversationsPanel` alongside the mission's real agents — including the architecturally separate `mission-copilot`, a normal per-mission team member — a second "copilot"-shaped presence where only one was needed. Removed entirely from the cockpit (roster, thread merge, recipient toggling, styling in `ConversationsPanel.tsx`; dead `COPILOT_ID`/`fetchCopilotHistory`/`sendToCopilot` exports deleted from `data.ts`) — no backend change, `/api/copilot/*` and the control-plane UI's own copilot access are untouched. ✅ **Objectives → MongoDB migration shipped** — removed the Fly-volume-vs-`teamFiles` two-copy architecture that caused the 26b incident. New `objectivesGoals`/`objectivesEvents` collections + `ObjectivesRepository` replace `sharedDir/objectives/*` files; the pure fold engine (`foldStore`) needed zero changes. The four Bash skill scripts are deleted, replaced by `AddTask`/`UpdateTask`/`RecordKpi`/`Allocate` tools on every agent (required, not stylistic — Bash subprocesses have no `MONGODB_URI`); new copilot-only `EditObjectiveTree` tool replaces the copilot's previous ad hoc `WriteFile` access to `goals.json`. Existing missions self-migrate once via a boot-time check (`migrateLegacyObjectivesStore`) — no standalone script, since objectives files live per-mission on a Fly volume only reachable while that mission's daemon runs. `ReviewObjectives`/`AssessKpi` and a new non-proxied `GET /api/missions/:id/objectives` route switched from monitor-proxy/`privateIp`-gated access to direct Mongo — both now work on a suspended mission, closing the ADR-0019-named blank-panel gap. The 26b interim fix (seed-if-missing special-case + its ACL-grant block) is deleted outright. See [ADR-0019](docs/adr/0019-objectives-mongodb-migration.md) (Accepted, implemented) and closes [issue #23](https://github.com/arnadu/magi_v3/issues/23). Also [issue #10](https://github.com/arnadu/magi_v3/issues/10) (OpenRouter provider-reported actual cost) — continues this window's cost-tracking accuracy work rather than sitting in either UI or hardening. **pi-ai forked, patched, and upgraded (ADR-0023)** — first concrete step on issue #10: forked `earendil-works/pi` (the renamed, maintained successor to the dead `badlogic/pi-mono`/`@mariozechner/pi-ai` scope) at current `main`, patched to surface OpenRouter's real `usage.cost` as a new `Usage.providerCost` field (~10 lines across `types.ts` + `api/openai-completions.ts`), fully re-tested (pi's own suite 681/681; MAGI_V3 build/lint/303-unit/90-integration, run twice — once against the local fork, once against the final delivery mechanism) to separate patch correctness from the ~30-version jump's own risk (0.52.12→0.82.1). Fixed rather than shimmed one real breaking change from the jump (pi v0.80.0 moved `completeSimple`/`getModel` to a documented-temporary `/compat` entrypoint — migrated the 4 call sites to the new `Models` API instead). Shipped via `patch-package` against the real published `@earendil-works/pi-ai@0.82.1` (npm-aliased, no import specifier changes), not a `file:` link to the fork clone — a first attempt at exactly that would have broken both Dockerfiles' build (context is the repo root only, can't reach a sibling directory). Deployed to dev only, pending real-world running time before production, given the blast radius (every agent's LLM call). **Cost-attribution wiring done same day**: `makeOnLlmCall` now prefers `usage.providerCost` over the static estimate for `totalCostUsd` whenever present, via a new pure `resolveCallCost()` (unit-tested, mirrors `resolveLiveLimits` from ADR-0018); `costEstimated` is genuinely `false` for any OpenRouter call that reported its own cost. Verified with a real OpenRouter call (not just unit tests) — `usage.providerCost` came back populated end to end. Issue #10 stays open for one remaining piece: the upstream PR. See [ADR-0023](docs/adr/0023-pi-ai-fork-openrouter-cost-patch.md). **[Issue #24](https://github.com/arnadu/magi_v3/issues/24)** (prompt-cache efficiency) **— OpenRouter half shipped (ADR-0024)**: the `providerCost` wiring above made real OpenRouter spend visible for the first time, and a read-only `llmCallLog` query against the live `gold-digest-v2` mission found 16/58 calls (27.6%) over 24h were full cache misses, ~$0.68/day wasted — only 1 of those 16 aligned with the 5-minute timestamp bucket, pointing at OpenRouter routing inconsistency as the dominant real cause, not MAGI's own prompt instability. Two fixes: explicit OpenRouter session affinity (`models.ts`'s `withOpenRouterAffinity()` sets the `compat.sendSessionAffinityHeaders` pi-ai defaults off for every provider; `loop.ts` threads a stable `missionId:agentId` through as `sessionId` — verified live by instrumenting the installed package to confirm `x-session-id` actually goes out), and a fully static system prompt (`buildSystemPrompt()` drops `mentalMapHtml`/`timezone` entirely, zero YAML changes needed; new `buildDynamicContextMessage()` carries the mental map + time block as `messages[0]`, replaced in place only when it changes). Scoped to the main turn loop, not sub-loops or one-shot vision calls. See [ADR-0024](docs/adr/0024-openrouter-cache-efficiency.md). Not yet verified: the actual production miss-rate drop. Kept out of Sprints 27/28 deliberately — both of those are external-facing work; this sprint is purely internal data-model completion |
| 27 | ⬜ Planned | **UI consolidation.** Build cockpit feature parity — auth/login, mission list + create + destroy, a read-only template browser (templates are immutable/disk-only per ADR-0022 — browse + launch, no editor), standalone copilot chat — then retire the vanilla `packages/control-plane/public/index.html` dashboard (1934 lines). Today the cockpit SPA covers only per-mission deep-dive tabs (Objectives/Files/Transcripts/Trace/Limits); none of auth, mission CRUD, template browsing, or copilot chat exist there yet, so this is real feature-build work, not a deletion. Control-plane housekeeping in the same sprint: once nothing depends on `index.html`, remove the now-dead routes and static-serving code that only existed to support it. **Also in scope: in-app agent-error banner** — the daemon already fires an `agent-error` SSE event on provider failures, but neither the cockpit nor the legacy dashboard actually listens for or displays it; found during the pre-Sprint-27 issue review, natural fit alongside this sprint's own cockpit-parity work. **Landed so far, pulled forward out of order: a live production incident, not planned UI work** — ✅ conversation-recovery bugs + copilot model-switch guard (ADR-0025). Root cause: `loop.ts` persisted an assistant message's unexecuted tool call before checking whether the turn had aborted, so a model switch mid-turn (or any other abort cause) left a permanent dangling `tool_use`; the shared auto-recovery mechanism that exists for exactly this case had two independent bugs and never actually fired for any agent with real history. Fixed the root cause, the recovery path, added a busy guard rejecting a model switch while a turn is in flight instead of racing an abort, and repaired the live corrupted copilot data with the corrected logic. **Sprint 27's actual planned scope — auth/login, mission CRUD, template browser, standalone copilot chat, retiring `index.html`, the agent-error banner — has not been started** |
| 28 | ⬜ Planned | **Operational hardening**: G-5 out-of-band alerting (webhook/email on `agent-error`) — absorbs [issue #3](https://github.com/arnadu/magi_v3/issues/3) (background job failures not surfaced) and [issue #4](https://github.com/arnadu/magi_v3/issues/4) (Change Stream reconnect silent), both the same "push a transient SSE status/alert event on a known failure" pattern G-5 already covers; onboarding flow (first-login wizard); usage dashboard (per-user spend history); full `/security-review` pass — absorbs [issue #7](https://github.com/arnadu/magi_v3/issues/7) (Firebase `checkRevoked`) and [issue #21](https://github.com/arnadu/magi_v3/issues/21) (protect `sharedDir`'s `.git` history from destruction — substantial enough for its own line item, not folded silently into the generic review); deployment documentation update. **Also in scope: unblock F-021/F-023/F-026** — these were parked on "no confirmable UI surface yet"; the cockpit's chat drawer (Sprint 26b) is that surface now |
| 29 | ⬜ Planned | **Sensitive-data encryption.** Direction recorded in [ADR-0026](docs/adr/0026-sensitive-data-encryption-direction.md): application-level encryption so Fly and MongoDB cannot read mission data at rest (Fly's and Atlas's own default encryption are provider-key-controlled, not customer-opaque), opt-in per mission, plus OpenRouter `zdr: true` routing to cut LLM-provider retention where self-serve ZDR exists (direct Anthropic calls stay at standard 7-day retention — enterprise-only ZDR isn't practical at this scale). Needs a dedicated research pass before implementation: KMS provider choice, key custody model (operator-held vs. future per-user keys), migration path for existing plaintext mission data, hot-path encrypt/decrypt latency, and empirical verification of OpenRouter's ZDR fail-open/fail-closed behavior per upstream provider (DeepSeek, Kimi, Z.AI, Mistral) |

---

## Agent Alignment and Efficiency — Design Notes (Sprints 24–26c)

Sprints 24–26c share a unified goal: equip the copilot and operator with the instruments needed
to keep agents aligned with mission intent — delivering what is required without wasting tokens.
The full requirements analysis lives alongside this roadmap; this section is the durable summary.
Sprint 26c is this arc's deliberate closing sprint — see its row above.

**The throughline**: Sprint 24 builds the *measurement* (StatsCollector), Sprint 25 builds the
*outputs* (file tracking), Sprint 26 composes both into *outcome-oriented supervision* (the
cockpit). Each sprint's data feeds the next, so 26 is mostly composition, not new instrumentation.

### The feedback loop

```
Agent acts → StatsCollector persists (per call) → limits evaluated → copilot assesses/intervenes → operator supervises via cockpit
```

Hard limits fire mechanically in real time (mid-turn, via `onLlmCall`); soft limits and all
copilot/operator supervision act at turn (wakeup) boundaries.

### Three-layer statistics (Sprint 24)

A stateful `StatsCollector` (one per agent) maintains the picture via three hooks —
`onLlmCall`, `onToolResult` (new hook in `loop.ts`), `onTurnEnd` (sleep boundary). Persistence
is **incremental on every inner-loop iteration**, not only at sleep, so a paused or crashed
machine loses nothing and a running turn is visible live.

- **Per call** — `llmCallLog` (existing): raw audit trail; trace drill-down only
- **Per turn** — `agentTurnStats` (new): upserted with `$set` each iteration, finalized at turn
  end. Fields: `llmCallCount`, `peakContextTokens`, `costUsd`, `toolCalls{}`, `toolErrors{}`,
  `filesWritten[]`, `messagesSent[]`, `urlsVisited[]`, `reflectionTriggered`, `status`, `gitCommit?`
- **Mission level** — `missionStats` (new): `$inc` at turn end only (avoids double-count on
  restart-replay). Lifetime totals + cross-turn state (`consecutiveZeroOutputTurns`)

The limits module reads the in-memory collector — **no DB query in the enforcement hot path**.
On wakeup start, `missionStats` is reloaded so totals survive daemon restart.

### Limits framework (Sprint 24)

A configurable `LimitRule[]` table (metric × window × threshold × scope × action; `hard` flag)
decouples *what is measured* from *what to do about it*. Candidate triggers: mission cost cap
(hard, pause all), LLM-calls-per-turn ceiling (hard, abort turn) and warning (soft), turn cost,
peak context, consecutive tool errors, BrowseWeb/FetchUrl loop, consecutive zero-output turns.
**Hard = enforced mechanically; soft = routed to the copilot**, which reads context
(`ReadMissionLog`) before acting — automated rules without assessment produce false positives.
Interventions: `PostMessage` (exists), `PauseAgent`/`ResumeAgent`, `SetMissionBudget`, `NotifyUser`.

### File content tracking (Sprint 25)

Bash-written files are invisible to the tool-call interface, so file tracking is git-based:
the daemon commits the shared workspace at each turn end (serialized via an async mutex for
concurrent agents), stores the hash in `agentTurnStats.gitCommit`, and derives `filesWritten`
from `git diff`. **Volumes persist across suspend/resume** — history is lost only on
`destroyMission` (acceptable; extract-before-destroy deferred). No remote push needed.
Uploads and all document formats flow through one shared `document-processor.ts` with no text
truncation and first-class partial-processing markers.

### Outcome-oriented cockpit (Sprint 26)

The pivot from **transcript** to **state + exceptions**, grounded in Endsley Situation
Awareness (Perception → Comprehension → Projection), Management by Objectives/Exception, and
OODA. The new spine is the **`objectives` platform skill** (promoted from the DPO `dpo-tasks`
skill) — a file-based, git-versioned store at `sharedDir/objectives/` holding an **objective
tree → tasks + KPIs + budget**: objectives nest via `parent` and are owned by a supervisor
agent; tasks are leaves assigned to a worker with a status; KPIs hang off objectives with an
`owner` + `source` (`auto-stat` ← StatsCollector, `task-rollup`, `agent-reported`,
`copilot-assessment`, `manual`). **Budget**: `budgetUsd`/`costUsd` on every node; cost is
**attributed automatically** at the `StatsCollector.endTurn` hook — the turn's cost is split
across the tasks the agent updated this turn (relative `--effort` weights, default even), with
carry-over when no task is updated, a staleness-triggered `allocate` timesheet fallback, and
supervisor overhead landing on owned objectives. Delivered as a **skill** (SKILL.md discipline +
Bash scripts writing the store, mirroring git-provenance) — **no MongoDB collections**; the
store is the single source of truth, and the daemon mirrors each agent's owned tasks/KPIs/budget
into a managed `#my-objectives` **mental-map section** every turn (the bridge — agents read in
working memory, write via scripts). The copilot runs an `objectives-kpi` skill computing
cross-cutting auto KPIs into the same store. The **UI is a pure reader** of this store. KPIs and
tasks are **facets of one objective tree** — the primary panel is that tree (KPI/budget status
+ tasks per node); the by-agent kanban is a secondary lens. Goals/KPIs/budget are co-authored by
user+copilot at template design time and editable live. Panels map to SA levels: Objectives
(KPI+task), Messages-to-user, Deliverables, Trace chart, Chat/explore.

**The managerial↔conversational pivot is essential**: agents interview the user (e.g. DPO
privacy assessment) via `AskUser` — the agent posts a `requiresResponse` message and **sleeps**,
waking on the reply (no blocking compute); an "awaiting user input" agent is a first-class
exception surfaced in the cockpit. The user drops into a focused bidirectional chat with any
agent in one click. Built in React/Next.js (SPA rewrite pulled forward); split 26a (spine) / 26b
(trace + chat + rendering).

### Live vs historical trace (Sprint 26b)

Two modes, one viewer, built on the `experimental/dump-trace.mjs` prototype:
- **Live** (ongoing): subscribe to `agentTurnStats` Change Stream — O(turns), renders each turn
  as it completes; the `status: 'running'` doc shows the current turn updating in real time
- **Historical** (drill-down): lazy-load `llmCallLog` for a selected turn — O(calls in turn), on
  demand — for the within-turn context curve and tool sequence

`agentTurnStats` is the primary rendering unit; `llmCallLog` is fetched only on drill-down.

### Interactive HTML preview in Files (deferred, post-26b)

An agent may decide an interactive page — a dashboard, a chart built with a JS library — is the
best way to present something, not a static Markdown/CSV artifact. The Files panel (built in
26b, read-only) can support this with the same sandboxed-iframe pattern CodePen/JSFiddle/
CodeSandbox use for untrusted live previews:

- **Mechanism**: `<iframe sandbox="allow-scripts">` — deliberately **no** `allow-same-origin`.
  That combination forces the iframe into a unique, opaque origin regardless of where the HTML
  came from: no cookies, no control-plane session, no parent DOM access — but full JS execution,
  so a CDN-loaded charting library (Chart.js/D3/Plotly via absolute `https://` URLs) still works.
  No `allow-popups`/`allow-top-navigation`/`allow-forms` unless a concrete need appears.
- **Serving**: `srcdoc`, not a new endpoint — reuse the Files panel's existing text-content fetch
  (`/files/shared`) and pass it straight into `srcdoc`. `srcdoc` content has no real URL, so
  relative-path asset loading (`<script src="app.js">`) does **not** resolve — scope is therefore
  **self-contained single HTML files** (inline `<style>`/`<script>` + absolute CDN URLs), not
  multi-file mini-apps.
- **UX**: `.html`/`.htm` in the Files panel gets a **Preview / Source** toggle (Preview = the
  sandboxed iframe, default; Source = the existing text view, for debugging).
- **Residual risk (accepted, same as any "run untrusted HTML" tool)**: sandboxed script can still
  make outbound `fetch()` calls to third parties — it just can't reach the control plane with
  credentials or read the operator's session.
- **Natural follow-up, if multi-file apps are ever needed**: a `GET /files/shared/raw?path=`
  endpoint serving real bytes with correct `Content-Type` (reusing the existing path-validation
  pattern from `/files/shared`/`/download`), with the iframe's `src=` pointing at it directly
  instead of `srcdoc` — lets relative asset paths resolve against a real URL. Bigger lift
  (content-type sniffing, more SSRF/path-traversal surface to review); only build if single-file
  HTML genuinely isn't enough.

### Operational resilience gaps (from `docs/operational-resilience.md`)

These are backlog candidates — pick them up in priority order as sprint capacity allows.

| Gap | Severity if triggered | Fix complexity | Candidate sprint |
|-----|-----------------------|----------------|-----------------|
| ~~**G-1**~~ ~~No auto-restart policy on Fly execution machine~~ | ~~🟠 Mission stall~~ | **Closed Sprint 20** — `restart: { policy: "on-failure", max_retries: 3 }` added to `fly-machines.ts` | ✅ |
| **G-3** Missed cron fires not replayed on daemon restart — equity research daily brief silently skipped if daemon is down at fire time | 🔴 Data loss | Moderate — startup catch-up scan of `scheduled_messages` for past-due undelivered entries (~20 lines in `daemon.ts`) | **24** |
| ~~**G-6**~~ ~~Orphaned background jobs not cleaned on restart~~ | ~~🟠 Mission stall~~ | **Closed Sprint 12** — `recoverOrphanedJobs()` in `daemon.ts` | ✅ |
| **G-4** No disk monitoring for Fly Volume — volume fills silently, writes fail with no alert | 🔴 Data loss | Moderate — log disk usage in daemon heartbeat; surface in dashboard stats tab | **25** |
| **G-2** Inbox messages marked-read before agent completes — inbox text lost on crash in the narrow window between `markRead` and `runAgent` completion | 🟠 Mission stall | Moderate — two-phase read/ack in orchestrator (`processing` → `read` in `.finally()`) | **24** |
| **G-5** No out-of-band alerting for LLM auth failure / credits exhausted — operator must notice dashboard banner | 🟠 Mission stall | Moderate — POST to a webhook or send email on `agent-error` with `transient: false` | **28** |

---

## Post-MVP (after Sprint 27)

| Item | Notes |
|------|-------|
| ~~React / Next.js frontend~~ | **Promoted to Sprint 26a** — the cockpit is the forcing function for the SPA rewrite |
| ~~Git-backed file versioning~~ | **Promoted to Sprint 25** — git-commit-on-turn-end, hash in `agentTurnStats.gitCommit` |
| Multi-tenant + billing | Per-user API key (BYOK); usage-based billing; tenant isolation beyond shared system key |
| Evaluation harness | Golden scenarios for structural/policy outcomes; CI regression suite |
| Mission builder UI | Guided copilot flow + form-based config; `DestroyMission` tool |
| `ProcessMore(artifactId)` tool | Resume document processing past the automatic limit (PDF pages beyond vision cap, nested ZIPs, chart-only sheets) — uses the `unprocessed` marker as resume point |
| RAG facility | MongoDB Atlas Vector Search (`$vectorSearch`); `missionDocuments` collection + `SearchMemory` tool; deferred until a mission demonstrably exhausts context on its own collected data (V2 had an implementation to draw on) |
| Extract-before-destroy | Push git history to remote or extract to MongoDB before `destroyMission` deletes the volume, if audit requirements arise |
| Interactive HTML preview in Files | Sandboxed `<iframe srcdoc sandbox="allow-scripts">` (no `allow-same-origin`) for agent-authored self-contained HTML/JS dashboards — see design notes under Sprint 26b |

---

## Reference

The original sprint-by-sprint pre-implementation plans (including rejected designs for Temporal,
Redis, MinIO, and MockLLMProvider) are preserved at
[docs/discarded/sprint-plans.md](docs/discarded/sprint-plans.md).
