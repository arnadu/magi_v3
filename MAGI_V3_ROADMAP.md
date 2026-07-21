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
| 26a | ✅ Done | **Outcome-oriented cockpit (spine)**: pivot to **state + exceptions** (Endsley SA + MBO/Exception + OODA). **`objectives` platform skill**: file-based git-versioned `sharedDir/objectives/` store — objective tree (nestable, supervisor-owned) → tasks (worker-assigned, status) → KPIs (owner + `source`) + **budget** (A1/A2). **Automatic cost attribution** at turn end — `--effort` split, carry-over, `allocate` staleness fallback, supervisor overhead (B2/B2b). Daemon `#my-objectives` **mental-map bridge** every turn (B1). Copilot `ReviewObjectives`/`AssessKPI` tools (C1). **No MongoDB goal/task collections** — the file store is the single source of truth. **Deferred (additive, per original design):** `AskUser`/`requiresResponse`/awaiting-input state — an unread message from an agent already serves as the "look at this" signal; not worth the extra state machine for the MVP |
| 26b | 🟡 In progress | **Monitoring + exploration**: cockpit SPA shipped in the control-plane image (E1, E1-live). **Done:** Objectives panel; Conversations rail (Messages read/unread — D1 — merged with the **bidirectional per-agent chat drawer**, the managerial↔conversational pivot); Transcripts tab (LLM-log drill-down, collapsible sub-loop boxes); Files panel (workspace tree, type-driven rendering, provenance deep-links — **read-only**); rich artifact rendering (Markdown tables, Mermaid, KaTeX); **Trace chart panel**, in three iterations — mission cost+interaction overview → cumulative cost-over-time line chart (matching the mock) → turn bounding boxes (sized by `llmCallCount`) + file/message/scheduled-wakeup/aborted-turn marker lanes, all from `agentTurnStats`/`mailbox` with no new backend instrumentation; **Trace turn click-to-drill-down** into `llmCallLog` (brush-to-zoom overview strip + click-to-drill-down from every turn box/dot/file/anomaly marker) — landed as part of Trace panel interactivity (issue #22); also a same-window, unplanned **single-source-of-truth hardening thread** — cost-tracking (ADR-0017), limit-configuration (ADR-0018), and an objectives resume-time-overwrite incident fix (interim; full fix is ADR-0019, moved to Sprint 26c). **Remaining, moved to Sprint 26c:** Files panel direct-edit → notify-last-agent (write side of the design); cockpit-vs-chat **mode auto-selection**; copilot wake-up attribution and persisted anomaly/limit-breach logging (both need new backend instrumentation, explicitly deferred when scoping the marker lanes) |
| 26c | ⬜ Planned | **Close out the 24–26 alignment-infrastructure arc.** Cockpit leftovers carried from 26b: Files panel direct-edit (write side, notify-last-agent), cockpit-vs-chat mode auto-selection, copilot wake-up attribution + persisted anomaly/limit-breach logging (new backend instrumentation — today "anomaly" exists only in doc comments/prompt text, no real data source). Plus the deliberate follow-through on this window's single-source-of-truth thread: **objectives → MongoDB migration** — removes the Fly-volume-vs-`teamFiles` two-copy architecture that caused a real incident (agent-facing tools replace the Bash-script skill, since agent Bash subprocesses have no `MONGODB_URI` by design). See [ADR-0019](docs/adr/0019-objectives-mongodb-migration.md) (Proposed) and [issue #23](https://github.com/arnadu/magi_v3/issues/23) for the full design, alternatives considered, and cost breakdown. Kept out of Sprint 27 deliberately — 27 is external launch readiness (alerting, onboarding, security, UI consolidation), a different kind of work than an internal data-model migration |
| 27 | ⬜ Planned | **Launch hardening**: G-5 out-of-band alerting (webhook/email on agent-error); onboarding flow (first-login wizard); usage dashboard (per-user spend history); full `/security-review` pass; deployment documentation update; **UI consolidation** — strangler-migrate the vanilla `index.html` dashboard (auth, mission CRUD, template/config editor, copilot chat) into the React cockpit SPA, then retire `index.html` (frontend-only; API unchanged) |

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
| **G-5** No out-of-band alerting for LLM auth failure / credits exhausted — operator must notice dashboard banner | 🟠 Mission stall | Moderate — POST to a webhook or send email on `agent-error` with `transient: false` | **27** |

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
