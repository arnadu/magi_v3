# Implementation History — Sprint Build Log

Sprint-by-sprint record of what was built and which files were created or changed.
Read this to understand *why* a design decision was made; read the source code to understand *what* it does.
For design rationale, see the ADRs in `docs/adr/`.

---

## Key files (packages/agent-runtime-worker/src/)

**`packages/agent-config`** (Sprint 2):
- `src/loader.ts` — `loadTeamConfig(path)` / `parseTeamConfig(yaml)`: Zod schema validation; exports `AgentConfig = Record<string,string>` and `TeamConfig`. Required agent fields: `id`, `supervisor`, `systemPrompt`, `initialMentalMap`, `linuxUser`.

**`packages/agent-runtime-worker`** (Sprints 1–4):
- `src/loop.ts` — `runInnerLoop(config)`: LLM→tool→LLM loop via `completeSimple`. Terminates when the LLM stops calling tools. Fires `onMessage` after every message. `toolTimeoutMs` (default 120 s) enforced via `withTimeout` on every tool call. `getSystemPrompt: () => string` (not `systemPrompt: string`) — called before each LLM call so mental map changes are visible within the same session (Sprint 11). `maxTurns?` hard-caps LLM calls for agentic sub-loops (Sprint 10). `onLlmCall?` callback fires after each `completeFn` call (Sprint 9).
- `src/tools.ts` — `createFileTools(workdir, acl: AclPolicy)`: `Bash`, `WriteFile`, `EditFile`. `AclPolicy` carries `agentId`, `permittedPaths`, and `linuxUser`. Shell tools dispatch via `runIsolatedToolCall()`: forks `sudo -u <linuxUser> node tool-executor.js` with only `PATH` and `HOME` set (no secrets in child env). `checkPath` rejects paths outside `permittedPaths` with `PolicyViolationError` before any filesystem access. Bash uses OS-level enforcement (the sudoed user has no write access to other agents' dirs). Response bodies capped at 50 MB; Bash timeout validated (NaN/negative falls back to 30 s default) and capped at 600 s. `verifyIsolation(linuxUser, workdir)`: startup invariant check — forks a child via the normal isolation path and asserts `ANTHROPIC_API_KEY` is absent; throws if sudo is misconfigured or if secrets leak.
- `src/tool-executor.ts` — clean child entry point for isolated tool execution. Launched by the orchestrator via `sudo -u <linuxUser> node dist/tool-executor.js`. Reads `ToolRequest` JSON from stdin, dispatches to `execBash` / `execWriteFile` / `execEditFile`, writes `ToolResponse` JSON to stdout, exits. Never imports anything that touches secrets.
- `src/workspace-manager.ts` — **dev stopgap.** `WorkspaceManager` creates per-agent workdirs (`homeBase/linuxUser/missions/missionId`) and the shared mission dir (`missionsBase/missionId/shared`), applies `setfacl` for mutual access. Does NOT create or delete OS users — that is the control plane's job. Exports `WorkspaceLayout` and `AgentIdentity { workdir, sharedDir, linuxUser }`. `provision(missionId, agents)` creates skill directories, copies platform and team skill packages, applies setfacl, runs `git init -b main` on `sharedDir` only if `.git` does not yet exist (idempotent). `teardown()` logs failures rather than silently ignoring them.
- `src/mailbox.ts` — `MailboxRepository` (MongoDB, sort-consistent: newest-first); `PostMessage`, `ListTeam`, `ListMessages`, `ReadMessage` tools. Uses `teamConfig.mission.id` (not hardcoded). `PostMessage` validates recipient against team roster; body capped at `MAILBOX_MAX_BODY_BYTES` (100 KB).
- `src/mental-map.ts` — `UpdateMentalMap` tool; `patchMentalMap` pure function (jsdom-based). Mental map state held in memory during a session and persisted as `mentalMapHtml` on `AssistantMessage` documents in `conversationMessages` (Sprint 11).
- `src/artifacts.ts` — `generateArtifactId(sourceHint)`, `saveArtifact(workdir, id, files, meta)`, `saveUpload(workdir, id, files, meta)`. Exports `FileEntry { name, content }`.
- `src/mime-types.ts` — shared MIME type constants: `MIME_TO_EXT`, `EXT_TO_MIME`, `VISION_MIMES`. Single source of truth imported by `fetch-url.ts` and `inspect-image.ts`.
- `src/skills.ts` — `discoverSkills(sharedDir, workdir): SkillsBlock`: scans four tier directories in order (platform → team → mission → agent-local); extracts YAML frontmatter from each top-level `SKILL.md`; resolves name collisions (higher tier wins). Only real directories scanned (symlinks excluded). `formatSkillsBlock(block)`: formats for system prompt injection.
- `src/prompt.ts` — `buildSystemPrompt(agent, mentalMapHtml, sharedDir, workdir)`: substitutes `{{mentalMap}}` in `agent.systemPrompt`, appends skills block. `formatMessages(messages)` formats the inbox as the opening user turn.
- `src/agent-runner.ts` — `runAgent(agentId, messages, ctx, signal)`: loads mental map from most recent `mentalMapHtml` in `conversationMessages`; holds it in `currentMentalMapHtml`; passes `getSystemPrompt = () => buildSystemPrompt(...)` so mental map changes within the session are reflected in subsequent LLM calls; tracks `currentCallSeq`; wires `UpdateMentalMap` as a pure in-memory tool; appends sub-loop messages from Research with `parentToolUseId`; calls reflection before the inner loop; calls `browseWebHandle?.close()` in finally.
- `src/orchestrator.ts` — `runOrchestrationLoop(config, signal)`: provisions workspace, then calls `verifyIsolation()` before the first cycle; inbox-poll scheduling; runs agents in supervisor-depth order (seniors first); supports `--step` mode and live readline input; terminates when no agent has unread messages. `teardownOnExit?: boolean` (default `false`) — must be explicitly set to `true` in CLI/tests.
- `src/user-input.ts` — readline handler: `/command` dispatch; `@path` scanning (extracts `@/abs` or `@./rel` tokens, calls `saveUpload`).
- `src/cli.ts` — multi-agent CLI; requires `TEAM_CONFIG`; derives `teamSkillsPath` from TEAM_CONFIG path; provisions workspace via `WorkspaceManager`; registers `SearchWeb` when `BRAVE_SEARCH_API_KEY` is set.
- `src/models.ts` — `CLAUDE_SONNET`, `CLAUDE_HAIKU` constants; `anthropicModel()` factory with cache pricing (cacheRead = input × 0.1, cacheWrite = input × 1.25).
- `src/tools/fetch-url.ts` — `createFetchUrlTool(model, sharedDir)`: HTTP GET → Readability (HTML) or mupdf (PDF) → `content.md`; downloads up to `max_images` images; vision LLM auto-describes each image; writes artifact folder + `meta.json`. `file://` URLs rejected (LFI fix).
- `src/tools/inspect-image.ts` — `createInspectImageTool(workdir, model)`: reads image file (path traversal rejected), base64-encodes, calls vision LLM.
- `src/tools/search-web.ts` — `createSearchWebTool(apiKey)`: Brave Search REST API → ranked markdown result list; not registered when key absent.
- `src/tools/browse-web.ts` — `BrowseWebHandle { tool, close() }` factory; `tryCreateBrowseWebTool(model, sharedDir)` returns `undefined` if Chromium absent; one Stagehand instance (lazy-init) shared across all `execute()` calls within a handle; SSRF protection (regex + DNS lookup + post-redirect check); trust boundary markers; 5 MB cap. Provider routing: Anthropic models passed as `"anthropic/<id>"` string; OpenRouter models passed as `{ modelName, apiKey, baseURL }` object.
- `src/tools/research.ts` — `createResearchTool(model, sharedDir, acl)`: agentic tool; cache in `sharedDir/research/index.json`; sub-loop with FetchUrl, Bash (sharedDir-only), SearchWeb; `RESEARCH_MAX_TURNS = 10`. Extended with `context_files?: string[]` and `output_path?: string` params (Sprint 12).
- `src/reflection.ts` — `convertToLlm`, `serializeForReflection`, `buildReflectionSystemPrompt`, `runReflection`; saves cumulative summary before `compact()` (crash-safe).
- `src/conversation-repository.ts` — `StoredMessage` with `compacted`/`isReflection`/`callSeq`/`mentalMapHtml`/`parentToolUseId` fields; `SummaryMessage` type; `compact()` via `updateMany`; unique index with migration for error code 85.
- `src/llm-call-log.ts` — `LlmCallLogEntry` schema; `computeCost(usage, modelCost)` with per-component USD breakdown; `truncateToolBodies(messages)` caps at 2 000 chars; `createMongoLlmCallLogRepository(db)`.
- `src/daemon.ts` — persistent daemon; Change Stream wake-up; node-cron heartbeat; `ToolApiServer` lifecycle; `runPendingJobs()` scans `sharedDir/jobs/pending/`; clean shutdown with double-Ctrl-C guard.
- `src/monitor-server.ts` — HTTP + SSE dashboard on `MONITOR_PORT` (default 4000). Routes: `GET /`, `GET /events`, `GET /team`, `GET /status`, `GET /mailbox`, `GET /agents/:id/mental-map`, `GET /agents/:id/sessions`, `GET /agents/:id/sessions/:turn`, `GET /log`, `POST /send-message`, `POST /step`, `POST /toggle-step`, `POST /start`, `POST /stop`, `POST /extend-budget`.
- `src/tool-api-server.ts` — `ToolApiServer` class; HTTP on `TOOL_PORT` (default 4001, loopback-only); bearer token auth; dispatches `POST /tools/<name>` to FetchUrl, InspectImage, Research, SearchWeb, PostMessage.
- `src/cli-post.ts` — inserts one `MailboxMessage` to mailbox; `--to <agentId>` flag.
- `src/cli-tail.ts` — Change Stream watch on mailbox; `--all` flag for inter-agent traffic.
- `src/cli-tool.ts` — `magi-tool` CLI; stdlib HTTP client; `--question`, `--context-file`, `--output`, `--url`, `--to`, `--subject`, `--body` flags.
- `src/cli-usage.ts` — aggregate usage/cost report from `llmCallLog`; `--detail` for per-call rows; `--agent`, `--from`, `--to`, `--reflection` filters.
- `src/cli-reset.ts` — wipes MongoDB data + workspace dirs for a mission; `--db-only`, `--yes` flags.

---

## Tool Capabilities (Implementation Priority Order)

**Sprints 1–3:**
- `Bash`, `WriteFile`, `EditFile` — file and shell work
- `PostMessage` — send to one or more agent ids (or `"user"` to reach the operator)
- `UpdateMentalMap` — surgical HTML patching of the agent's Mental Map document (jsdom-based)
- `ListTeam` — read agent roster from team config: id, name, role, supervisor
- `ListMessages` — inbox headers for older messages: from, subject, timestamp
- `ReadMessage` — read full older message by id
- `FetchUrl` — HTTP GET → Readability (HTML) or mupdf (PDF) extraction; image download; artifact folder; vision auto-describe
- `InspectImage` — pass any image file to the vision LLM; returns text description; path traversal safe
- `SearchWeb` — Brave Search API; ranked result list; artifact saved; conditionally registered

**Sprint 5 — Skills:**
No new tools. `discoverSkills(sharedDir, workdir)` scans four tiers (platform → team → mission → agent-local); `formatSkillsBlock()` injects a compact block into each agent's system prompt via `buildSystemPrompt()`. Block contains three concrete resolved paths and the skill list. Symlink injection prevented: only real directories scanned.

`provision()` copies `packages/skills/` → `sharedDir/skills/_platform/` and `config/teams/{team}/skills/` → `sharedDir/skills/_team/` (if present); applies `r-x` setfacl on `_platform/` and `_team/`; creates `mission/` (rwx for all agents). Runs `git init -b main` on `sharedDir` only if `.git` does not yet exist.

Platform default skills in `packages/skills/`: `skill-creator`, `git-provenance`, `inter-agent-comms`.

**Sprint 6 — Persistent Daemon and Conversation Persistence:**
Conversation persistence (ADR-0008): each agent maintains a full, growing conversation across all its wakeups. `InMemoryMailboxRepository` and `InMemoryMentalMapRepository` deleted — MongoDB is the only implementation. `runInnerLoop` gains `previousMessages?: Message[]` and returns `Message[]`.

MongoDB-native scheduling infrastructure: `scheduled_messages` collection + `node-cron` heartbeat delivers pending documents to the mailbox; re-arms from DB on restart.

**Sprint 7 — BrowseWeb:**
Playwright/Stagehand headless browser; renders JS pages; session state (cookies, auth tokens) persists across multiple `execute()` calls within the same agent turn. Conditionally registered (returns `undefined` if Chromium absent). SSRF protection: pre-navigation regex + `dns.promises.lookup()` (DNS rebinding), post-redirect hostname check. Content capped at 5 MB.

`schedule-task` platform skill deferred to Sprint 8. `run-background` platform skill deferred to Sprint 8.

**Sprint 8 — Equity Research Team MVP:**
Four-agent team: Lead Analyst (supervisor: user), Economist, Junior Analyst, Data Scientist. Ticker hardcoded in team YAML. `schedule-task` platform skill: writes a cron entry to `scheduled_messages` collection; triggers timed agent wakeups via the Sprint 6 node-cron heartbeat.

**Sprint 9 — Context Management and Reflection (ADR-0009):**
Session-boundary compaction: every session's raw messages compacted at the start of the *next* session. Reflection: conditional (skipped if `peakInputTokens < REFLECTION_CTX_THRESHOLD = 120,000` tokens); separate LLM call consolidates the previous session; saves cumulative summary before `compact()` runs (crash-safe). Reflection LLM calls tracked by `UsageAccumulator` and visible in monitor dashboard.

LLM call audit log (`llmCallLog` collection): every LLM call recorded with full system prompt, truncated message context, full response, and correctly-computed costs.

Cache cost fix: `anthropicModel()` now computes cache pricing from input price ratio. CLAUDE_SONNET: $0.30/MTok read, $3.75/MTok write.

**Sprint 10 — Agentic Tools: Research (ADR-0010):**
Three tool categories formalised: simple tools (pure functions), stateful tools (`{ tool, close() }` handle pattern), agentic tools (run own `runInnerLoop` with restricted tool set). `Research` agentic tool: cache in `sharedDir/research/index.json`; sub-loop with FetchUrl, Bash (sharedDir-only), SearchWeb; `RESEARCH_MAX_TURNS = 10`. `maxTurns` added to `InnerLoopConfig`.

**Sprint 11 — Dashboard UX:**
`mental_maps` collection dropped — mental map HTML stored inline as `mentalMapHtml` on each `AssistantMessage`. `InnerLoopConfig.systemPrompt: string` → `getSystemPrompt: () => string`. `callSeq` and `parentToolUseId` fields added to `StoredMessage`. Sessions tree UI: Session → LLM call → Tool calls. Budget pause: `MAX_COST_USD` no longer terminates daemon — pushes `cost-pause` SSE event and blocks via `monitor.waitForBudget()`. `OrchestratorConfig.teardownOnExit?: boolean` (default `false`). `cli:reset` command added. Clean daemon shutdown: `server.closeAllConnections()` + `process.exit(0)`.

**Sprint 12 — Data Factory + Secondary Model (ADR-0011):**

*Phase 1 — Secondary model:* `CLAUDE_HAIKU` constant; `visionModel?` in `OrchestratorConfig` and `AgentRunContext`; FetchUrl/InspectImage/BrowseWeb use `ctx.visionModel ?? ctx.model`. `VISION_MODEL` env var.

*Phase 2 — Data factory Python core:* Two-skill architecture (`data-factory/` for operator, `data-factory-client/` for consumers). Python venv at `/opt/magi/venv`; `magi-python3` wrapper script (not symlink). Shebang-based interpreter dispatch. `.env` split: orchestrator secrets in `.env`, data keys in `.env.data-keys`. 7 adapters (fmp, fred, yfinance, newsapi, gdelt, imf, worldbank) with uniform `--discover`/`--fetch` CLI.

*Phase 3 — Tool IPC Server + Background Jobs:* `ToolApiServer` on `TOOL_PORT` (default 4001, loopback-only); bearer token auth. `magi-tool` CLI. File-based job state: `sharedDir/jobs/{pending,running,status}/` + `logs/bg-<id>.log`. Platform skill `run-background/`: `submit-job.sh`, `schedule-job.sh`, `job-status.sh`, `magi_tool.py` (stdlib-only Python SDK).

**Sprint 13 — Hardening and Launch Prep:**
SSRF improvements, security audit findings addressed, integration test stability improvements.

**Sprint 14 — Cloud Infrastructure MVP:**
Fly.io execution plane: `packages/agent-runtime-worker/Dockerfile` (multi-stage build; pool users magi-w1..w5; magi-operator uid 999). `packages/control-plane/`: Express API, Fly Machines client (`fly-machines.ts`), cron scheduler (`scheduler.ts`), HTTP reverse proxy (`proxy.ts`), single-page UI. GitHub Actions workflows for image build and control plane deploy.

Key lesson: Fly app-level secrets NOT automatically injected into Machines API-created machines — `fly-machines.ts` explicitly passes all required secrets in machine `env` at creation time.

**Sprint 15 — Developer Onboarding:**
`scripts/bootstrap.sh`: one-command setup (creates apps, sets secrets, builds + pushes image, deploys control plane); `--suffix <name>` for named instances. Root `.dockerignore` added. Test team configs relocated to `config/teams/test/`. Daemon log viewer: `GET /log?lines=N` in monitor server; "View Log" button in UI. `fly.toml` V1→V2 VM config fix (`cpu_kind`/`cpus` replaces `size`). Proxy `MaxListenersExceededWarning` fixed (proxy instance cached per target URL).

**Sprint 16 — Model Selection + Hardening:**
OpenRouter support via `MODEL` env var; model specified in team YAML. F-002 SSRF fix (additional IPv6 ranges). `agent-error` SSE event + dashboard banner for LLM provider errors with Resume button. MongoDB-backed team config templates with provision-time YAML injection; `seed-templates` script.

**Sprint 17 — Concurrent Agent Dispatcher:**
`runOrchestrationLoop` rewritten for fire-and-forget concurrent dispatch. `maxRuns` cap (default 50) limits total agent dispatches per loop lifetime. `isAgentPaused(agentId)` predicate allows per-agent pause without affecting others. `onWorkspaceReady` callback on `OrchestratorConfig` delivers `Map<agentId, workdir>` after provisioning. F-017: `verifyIsolation()` extended to check both `ANTHROPIC_API_KEY` and `OPENROUTER_API_KEY` using bash `${var:+word}` probe. Threat model refreshed.

**Sprint 18 — Mission Dashboard UI Rewrite:**
Full rewrite of the monitor dashboard (`public/index.html`, `public/style.css`, `public/app.js`). Key changes:

*Backend (`monitor-server.ts`):* Concurrent agent tracking — `runningAgents: Set<string>` replaces `runningAgent: string | null`; `agent-status` SSE payload changed from `{ running: string|null, pending: string[] }` to `{ running: string[] }`. `setAgentWorkdirs(map)` method for post-provisioning workdir registration. `GET /files/shared` and `GET /files/workdir/:agentId` endpoints for file browser; `serveFilePath()` serves directory listings, text (200 KB cap), base64 images, or binary sentinel. `DELETE /schedule/:id` endpoint calls `cancelSchedule` callback. Removed `GET /playbook` route. Optional `publicDir` constructor parameter (last arg, defaults to `dist/public/`) allows tests to point at the source `public/` directory without a build step.

*Frontend (`index.html` + `style.css` + `app.js`):* Two-panel layout: left panel is a chat-app-style thread list + chat view + compose bar (all mailbox messages, including agent-to-agent). Right panel has agent tabs (Activity / Mental Map / Files) and a Mission tab (Schedule / Files / Log / Stats). Thread list groups messages by **participant set** (sorted unique `from`+`to` values, pipe-joined) so operator messages and agent replies always appear in the same thread regardless of subject. Unread tracking persisted to `localStorage`. Chat bubbles render markdown via a self-contained `md()` function (~70 lines, no external dependency). Compose bar uses toggleable recipient chips pre-filled from the selected thread; `activeThread` is set before the `fetch()` call in `sendMessage()` so the SSE that arrives during the round-trip already finds the correct thread and calls `renderChatView()`. Kill button (red) replaced Stop button; requires `confirm()` dialog. Context warning: amber tab colour when agent context > 75% of limit. Step button triples as toggle/indicator/advance depending on state. Playbook removed entirely. File browser supports breadcrumb navigation, directory listing sorted dirs-first, text/markdown preview, and image preview. Stats tab shows per-agent cost and context breakdown from accumulated SSE data.

*Dashboard integration test (`tests/dashboard.integration.test.ts`):* Headless Playwright test that spins up a real `MonitorServer` + orchestration loop on a free port, drives the full operator message → agent reply round-trip via browser UI, and asserts both bubbles appear in the same chat thread. Run with `npm run test:integration -- "dashboard"`. Requires `ANTHROPIC_API_KEY`, `MONGODB_URI`, and pool users (`setup-dev.sh`). The workdir is `chmod 0o755` after creation so `magi-w1` can traverse it for isolation verification.

**Sprint 19 — Copilot Agent:**
Privileged assistant running inside the control plane with full MongoDB + Fly Machines access plus subprocess-isolated Bash/file tools.

*Isolation model:* Dedicated `magi-copilot` OS user (uid 60010) added to the control plane Docker image. Category A tools (Bash, WriteFile, EditFile, FetchUrl, SearchWeb, BrowseWeb) run via `sudo -u magi-copilot magi-node tool-executor.js` — no API keys in child env, workdir scoped to `/home/magi-copilot/workdir`. Category B tools (ListMissions, GetMissionStatus, ReadMissionMailbox, ReadMissionLog, ReadMissionFile, ListSchedule, ListTemplates, GetTemplate, ProposeAction) run in the main process with direct DB access.

*`packages/control-plane/src/copilot-tools.ts`* — B1 read-only tools (eight tools) and B2 `ProposeAction`. `ProposeAction({ type, label, payload })` stores the intent in `PendingActionsStore` and pushes a `copilot-action` SSE event for operator confirmation; returns immediately so the agent can continue its turn. `PendingActionsStore` is an in-memory map shared between the daemon and router.

*`packages/control-plane/src/copilot-daemon.ts`* — `startCopilotDaemon(db, repoRoot, modelId, pushEvent, pending)` — starts the watch loop. Watches the `mailbox` Change Stream for messages addressed to `missionId: "copilot"`, fetches and marks unread messages, calls `runCopilotTurn`. The turn loads conversation history (same `conversationMessages` collection as execution-plane agents), builds the system prompt from `copilot.yaml` with `{{mentalMap}}` substituted, assembles all tools, and calls `runInnerLoop` directly (no `WorkspaceManager` plumbing). Mental map snapshot is persisted on every AssistantMessage. `COPILOT_MISSION_ID = "copilot"` constant exported for router use.

*`packages/control-plane/src/copilot-router.ts`* — `POST /api/copilot/message` inserts a message into the copilot mailbox (triggering the daemon's Change Stream). `GET /api/copilot/events` SSE stream pushed from `CopilotEventBus`. `POST /api/copilot/confirm { pendingActionId }` looks up the pending action and executes it (LaunchMission, SuspendMission, ResumeMission, WriteMissionFile, SaveTemplate, CancelSchedule, CreateSchedule); pushes `copilot-action-result` event. `POST /api/copilot/dismiss` removes a pending action without executing it.

*`packages/control-plane/src/index.ts`* — copilot daemon started when `COPILOT_MISSION_ID` env var is set; copilot router mounted at `/api/copilot`; daemon stopped on SIGTERM/SIGINT.

*`packages/control-plane/Dockerfile`* — added `acl`, `sudo` packages; `magi-shared` group (gid 60100); `magi-copilot` user (uid 60010); `magi-operator` user (uid 999); `magi-node` wrapper; sudoers rule (`magi-operator ALL=(magi-copilot) NOPASSWD: /usr/local/bin/magi-node`); copilot workdir `/home/magi-copilot/workdir`; copies `agent-runtime-worker/dist` (for `tool-executor.js`) and TypeScript source of all packages (so copilot can read the codebase via Bash).

*`config/teams/copilot.yaml`* — copilot agent definition (id: copilot, supervisor: user). System prompt documents the two tool tiers, ProposeAction confirmation model, alert handling workflow, and codebase layout at `/app/packages/`.

*Alert routing:* `orchestrator.ts` gains `copilotMailboxRepo?: MailboxRepository`; posts structured alert messages to the copilot mailbox on wall-clock timeout abort and non-transient agent errors. `daemon.ts` reads `COPILOT_MISSION_ID` and creates a `copilotMailboxRepo` when set.

*Monitor server (`monitor-server.ts`):* Added `POST /files/shared/write` and `POST /files/workdir/:agentId/write` endpoints with path-traversal checks; used by the copilot's `WriteMissionFile` proposed action.

*`packages/agent-runtime-worker/src/index.ts`* — new exports: `Message`, `AssistantMessage` (from pi-ai), `ConversationRepository`, `StoredMessage`, `createMongoConversationRepository`, `resolveModel`, `convertToLlm`, `createBashTool`, `createFetchUrlTool`, `tryCreateSearchWebTool`, `tryCreateBrowseWebTool`.

*Control plane UI (`packages/control-plane/public/index.html`):* Added copilot chat panel: floating robot button (bottom-right), sliding side panel, chat bubbles (from-user / from-copilot / system), confirmation cards for `copilot-action` events (Confirm → `/api/copilot/confirm`, Dismiss → `/api/copilot/dismiss`), action result display, thinking indicator, SSE connection via cookie auth.

**Sprint 20 — Control Plane UX (Extended): Unified Config Editor + Home Screen + Quick Launch + Agent Management + Skill Toggles:**

Sprint 20 landed in two halves. The first half (base) built the three-column sidebar and raw block-editing tabs. The second half (extended) replaced raw textarea blocks with a structured config form and added home screen telemetry, quick launch, agent lifecycle controls, and skill toggles.

*Base layout (Sprint 20 initial):* `#sidebar` (240 px, collapsible to 40 px icon strip) | `#detail-panel` (flex:1) | `#copilot-panel` (420 px, unchanged). Three-column layout replaces the two-column header-tab design. Single `state` object unifies all globals. `renderSidebar()` renders Templates + Missions sections; `selectItem(type, id)` + `renderDetail()` drive navigation.

*Unified Config Editor (`renderConfigForm(type, id, config)`):* Replaces raw block textareas with a structured form. Mission tab (name, model, visionModel, advanced catchall textarea) + one agent tab per agent (name, role, linuxUser, supervisor, model, systemPrompt textarea, skills section, active checkbox, CodeMirror for mental map) + Files tab + Raw YAML (read-only). `state.configAgents` Map (keyed by `'t:id'` / `'m:id'`) is the authoritative agent list — populated by `renderConfigForm`, mutated by `addAgent`/`removeAgent`. YAML is reconstructed at save time via `buildAgentBlock` (js-yaml) + `buildMissionHeader`. 30-second poll re-renders only if the form is not dirty (no unsaved changes).

*YAML utilities:* `parseAgentBlock(block)` parses a single `- id: ...` YAML agent stanza via `jsyaml.load`, preserving native types for `active` (boolean) and `disabledSkills` (array). `buildAgentBlock(fields)` serialises back to YAML; omits `active` when true (cleaner YAML), omits `disabledSkills` when empty. `KNOWN_AGENT_FIELDS` list drives the known/rest split. `availableSkills(teamFiles)` derives the available skill set from platform defaults + team skill files embedded in the template.

*Agent active toggle:* Checkbox in each agent pane bound to `active` field. Unchecked → `active: false` written to YAML. `orchestrator.ts` skips `agent.active === false` in `dispatchReady()` so inactive agents do not receive dispatches. `active` and `disabledSkills` added as explicit optional fields in `AgentSchema` (before `.catchall()`) in `packages/agent-config/src/loader.ts`.

*Skill toggles:* Checkbox row per available skill in each agent pane. Unchecked skills accumulate in `disabledSkills[]`. `prompt.ts` filters `agent.disabledSkills` out of the skills block before injecting into the system prompt.

*Add / Remove agent:* `+ Agent` tab button calls `addAgent(type, id)` which pushes a blank agent into `state.configAgents` and injects a new tab + pane via `renderAgentPane()`. `removeAgent(type, id, agentId)` removes from `state.configAgents` and deletes the tab + pane from DOM. Remove button hidden when only one agent remains. Changes are included in the next `saveConfig()` call.

*Home screen (`renderHome()`):* Shown in `#detail-panel` when `state.selected === null`. Renders clickable session cards for running/suspended missions. Each card shows: name, status badge, unread message count, spend (last hour / today / total), last activity (relative time), and a snippet from the most recent conversation message. Stats fetched from `GET /api/missions/stats` in parallel with the 30 s mission list poll via `loadStats()`.

*Stats endpoint (`GET /api/missions/stats`):* Registered before `/:id` in `missions.ts` to avoid route shadowing. Runs three parallel MongoDB aggregations: unread counts from `mailbox` (read:false), spend breakdown from `llmCallLog` (total/today/lastHour grouped by `missionId`), last activity + snippet from `conversationMessages`.

*Quick launch (`startSession(templateId)`):* Template save bar replaced with "Save template" + "Start session ›". `startSession` reconstructs YAML from current widget state, auto-generates `missionId = "${templateId}-${yyyymmdd}-${4hex}"`, posts to `POST /api/missions` with inline `teamConfigYaml`, opens execution dashboard in new tab, and selects the new mission in the sidebar.

*POST /api/missions — inline YAML:* Extended to accept optional `teamConfigYaml` + `teamFiles` fields in the request body. When present, `parseTeamConfig` validates and `patchMissionId` injects the mission ID; template lookup is skipped. When absent, falls back to template lookup as before.

*POST /api/templates (create):* New `POST /` route in `templates.ts` creates a new template document (409 if already exists). Enables `doSaveAsTemplate(missionId)` in the UI: inline name input in session save bar → slugified ID → `POST /api/templates`.

*Session dual save bar:* Mission config form shows "Save config" + "Save as template…". "Save as template…" reveals an inline name input row; on confirm calls `doSaveAsTemplate`.

*Copilot `save_session_config` action:* `ProposeAction` type added to `VALID_TYPES` and description in `copilot-tools.ts`. `executeAction()` case in `copilot-router.ts`: validates mission is suspended, calls `parseTeamConfig`, updates `missions` collection (`teamConfigYaml`, `teamFiles`), optionally updates `conversationMessages.mentalMapHtml` per-agent if `mentalMaps` map provided.

*G-1 restart policy (closed):* `fly-machines.ts` `provisionMission()` now includes `restart: { policy: "on-failure", max_retries: 3 }` in the machine `config` object. Execution machines self-heal after crash/OOM up to 3 times without operator intervention.

---

## Sprint 21 — In-session context management + extended thinking

Goal: prevent context from growing unboundedly within a single session by stubbing ephemeral tool results and old thinking blocks; give agents a path to recover pruned content; enable extended thinking on the primary model.

**`src/context-utils.ts` (new):** `EPHEMERAL_TOOLS` — `Set` of tool names whose results are large and transient (Bash, SearchWeb, FetchUrl, BrowseWeb, ReadFile, InspectImage). `PRUNED_STUB` — the replacement text injected when a result is pruned. `pruneEphemeralResults(messages, keepLastRounds=2)` — two-pass scan: (1) replace `content` of ephemeral tool results from all rounds except the last `keepLastRounds` with the stub; (2) strip `{ type: "thinking" }` blocks from all assistant messages except the most recent one. Returns a new array; never mutates input. Already-stubbed results are skipped (idempotent). Durable tools (WriteFile, EditFile, PostMessage, …) are never touched.

**`src/models.ts`:** `anthropicModel()` now accepts an optional `reasoning?: boolean` flag and propagates it into the `Model` object. `CLAUDE_SONNET` (`claude-sonnet-4-6`) updated: `reasoning: true`, `maxTokens: 32_000` (raised from 16k to give room for thinking budget alongside text output). `CLAUDE_HAIKU` intentionally left at `reasoning: false` — it is the fast vision model used for captioning in FetchUrl/InspectImage/BrowseWeb; extended thinking there would be wasteful.

**`src/loop.ts`:** `InnerLoopConfig` gains `reasoning?: ThinkingLevel`. `callOpts` construction gates on both `config.reasoning` and `model.reasoning` so that non-thinking models are silently skipped. `MID_SESSION_PRUNE_THRESHOLD = 160_000` tokens (80% of 200k window); after each `assistantMessage` is pushed, `ctxSize = usage.input + usage.cacheRead` is checked — if it exceeds the threshold, `pruneEphemeralResults` runs and `messages.splice` replaces the array in-place. Only the live in-memory array is modified; MongoDB retains full content.

**`src/reflection.ts`:** `convertToLlm` now calls `pruneEphemeralResults(out, 2)` before returning, so cross-session history loaded at session resume is already lean.

**`src/conversation-repository.ts`:** `ConversationRepository` interface gains `findRelevant(agentId, missionId, query, limit)`. MongoDB implementation runs a case-insensitive regex search against `message.content` and `message.content.text` across ALL stored messages (no `compacted` filter — compacted messages are searchable). Over-fetches by 3× then trims to `limit`, extracting a 300-char excerpt window centered on the first match (100 chars before, 200 after).

**`src/tools/analyze-memories.ts` (new):** `createAnalyzeMemoriesTool(cfg)` returns a `MagiTool` named `AnalyzeMemories`. Parent-process tool (not subprocess-isolated). Accepts `query` (required) and `limit` (default 5, max 20). Formats results as `[turn N | role/toolName | timestamp]\nexcerpt` blocks separated by `---`. Used by agents to recover tool outputs that were stubbed by mid-session or cross-session pruning.

**`src/agent-runner.ts`:** `createAnalyzeMemoriesTool` added to the tool list (after `createResearchTool`). `reasoning: "medium"` passed to both `runInnerLoop` calls (main dispatch and retry). `"medium"` gives meaningful reasoning depth without the extreme cost of `"high"`.

**`tests/context-pruning.unit.test.ts` (new):** 9 unit tests covering tool classification, stub behavior for old rounds, durable-tool preservation, idempotency, thinking-block stripping, thinking retention in the last round, finished-conversation behavior (all thinking stripped when last message is a no-tool assistant response), not-enough-rounds no-op, and empty array.

## Sprint 24 (Phase 1) — Statistics collector (alignment-signal foundation)

Goal: build the three-layer statistics foundation that later Sprint 24 work (budget limits, copilot anomaly alerts) and Sprints 25–26 (file tracking, trace viewer) consume. This phase is **instrumentation only** — it collects and persists, it does not yet enforce limits. One `runAgent` call == one turn == one wakeup.

**`src/agent-stats.ts` (new):** Three layers — per-call `llmCallLog` (existing), per-turn `agentTurnStats` (new), mission-level `missionStats` (new). `AgentTurnStats` carries LLM aggregates (call count, tokens, cost, `peakContextTokens` = max of `input+cacheRead+cacheWrite` across calls), tool aggregates (`toolCalls`/`toolErrors` by name), and output signals (`filesWritten`, `messagesSent`, `urlsVisited`, `reflectionTriggered`, `status`). `MissionStats` carries lifetime totals + `consecutiveZeroOutputTurns`. `createMongoAgentStatsRepository(db)` — `agentTurnStats` upserted by `(missionId, agentId, turnNumber)` (unique index), `missionStats` `$inc` via `findOneAndUpdate` keyed by `(missionId, agentId)`. `StatsCollector` — stateful per-daemon class keyed internally by `agentId` (concurrent agents do not contend); lifecycle `startTurn → recordLlmCall/recordToolResult (repeated) → endTurn`. Persistence is **incremental** (upsert on every iteration → fault-tolerant, live trace data); `missionStats` `$inc` happens **once at turn end** so a replayed incomplete turn never double-counts. Persist/$inc failures are caught and logged, never thrown into the agent loop. Lifetime totals reload from `missionStats` on the first turn after a daemon restart (caps survive restart).

**`src/loop.ts`:** `InnerLoopConfig` gains `onToolResult?({ toolName, args, isError })`, fired after each tool result is pushed (in the daemon, outside the tool-executor sandbox). Existing single `onLlmCall` hook unchanged.

**`src/agent-runner.ts`:** `AgentRunContext` gains optional `statsCollector?`. `makeOnLlmCall` refactored to compute usage/cost once and feed both `llmCallLog` (if present) and the collector (non-reflection calls only — reflection runs before `startTurn`, surfaced via the `reflectionTriggered` flag). `startTurn` brackets the loop; `endTurn` runs in `finally` with status `aborted` when the signal aborted, else `complete`. `onToolResult` handler feeds `recordToolResult`.

**`src/orchestrator.ts`, `src/daemon.ts`, `src/cli.ts`:** `statsCollector?` threaded through `OrchestratorConfig` → `agentCtx`; instantiated in both daemon and CLI from `createMongoAgentStatsRepository(db)`. Exported from `src/index.ts` for downstream (control plane, Sprint 26).

**`tests/agent-stats.unit.test.ts` (new):** 7 unit tests against an in-memory fake repo — running-doc on startTurn, LLM aggregation + peak context, tool/error counting and file/message/URL extraction, once-only lifetime increment, zero-output-streak tracking + reset, lifetime reload after restart, concurrent-agent isolation.

**`tests/agent-stats.integration.test.ts` (new):** runs a real `hello-world` agent turn with both `llmCallLog` and the collector wired, then cross-checks the two independent data paths agree per turn (call count, exact token sums, cost to 8 dp, peak context) and that `missionStats` lifetime totals equal the sum across turns, plus PostMessage / message-to-user capture.

**Backward compatibility:** no team-YAML schema change; `agentTurnStats`/`missionStats` are new and created lazily; `statsCollector` and `onToolResult` are optional everywhere. Existing missions resumed under the new code start accumulating stats from their next turn (lifetime begins at 0); existing templates validate unchanged. No new env vars, secrets, or deployment steps.

## Sprint 24 (Phase 2) — Limits framework + enforcement

Goal: turn the statistics foundation into enforcement. Decouples *what is measured* (StatsCollector) from *what to do about it* (a configurable rule table).

**`src/limits.ts` (new):** Pure module — no I/O, fully unit-testable. `LimitRule` (id, metric, threshold, severity, label); metrics read either the turn window (`llmCallCount`, `costUsd`, `peakContextTokens`, `toolErrors`) or the lifetime window (`lifetimeCostUsd` = persisted lifetime + current turn so a per-agent cap trips mid-turn; `consecutiveZeroOutputTurns`). `buildRules(LimitConfig)` layers conservative soft defaults (`DEFAULT_SOFT_LIMITS`: warn at 40 calls / 160k ctx / 8 tool errors / 3 zero-output turns) under explicit overrides; hard rules (`maxLlmCallsPerTurn`, `maxCostPerTurnUsd`, `maxLifetimeCostUsd`) appear only when configured (opt-in). `evaluateLimits(turn, lifetime, rules)` returns every breach (value strictly > threshold). `LimitExceededError` carries the breached `LimitBreach`. `LimitAlert` contextualizes a breach with agentId + turnNumber for routing.

**`packages/agent-config/src/loader.ts`:** `AgentSchema` gains an optional `limits` block (`LimitsSchema`, `.strict()`) — `max*` (hard, positive) and `warn*` (soft, non-negative; 0 disables) fields, all optional. Declared key, exempt from the `.catchall(z.string())`.

**`src/agent-runner.ts`:** `AgentRunContext` gains `onLimitAlert?`. Builds `limitRules = buildRules(agent.limits)` when a collector is present. `enforceLimits()` reads the collector's in-memory `getTurn`/`getLifetime`, fires soft alerts (deduped via a per-turn `Set<ruleId>`), and on a hard breach fires an alert then throws `LimitExceededError`. `makeOnLlmCallWithLimits(turnNumber)` composes the existing audit-log/stats hook with a post-call limit check; `onToolResultHandler` re-checks after each tool result. The main loop is wrapped to catch `LimitExceededError` (sets `limitAborted`, logs, does not re-throw — it is a deliberate stop, not a crash); `endTurn` records `aborted` when `limitAborted || signal.aborted`.

**`src/orchestrator.ts`, `src/daemon.ts`:** `onLimitAlert?` threaded through `OrchestratorConfig` → `agentCtx`. The daemon implements it: pushes a `limit-alert` SSE event to the monitor dashboard and posts a structured alert to the copilot mailbox (when wired) so the copilot can assess and intervene between turns. New `MonitorEventType` value `limit-alert`. Exported from `src/index.ts`.

**Enforcement semantics:** hard limits complement (do not replace) the existing between-turn mission cost cap (`MAX_COST_USD` → `waitForBudget`): per-turn caps catch a single runaway *during* the turn; the mission cap gates the next dispatch. Soft limits never change behaviour — they only route an alert.

**Tests:** `tests/limits.unit.test.ts` (11) — `buildRules` defaults/opt-in/override/disable, `evaluateLimits` breach detection, toolErrors summing, mid-turn lifetime-cost tripping, zero-output streak, turn-vs-lifetime metric classification. `tests/limits.integration.test.ts` (1) — real hello-world run with `maxLlmCallsPerTurn: 1` proves the end-to-end path: breach on call 2 throws out of the hook, the turn finalizes `aborted` (useful PostMessage reply already sent on call 1), and a hard `onLimitAlert` fires.

**Backward compatibility:** hard limits are opt-in (no default → no existing turn is aborted); soft defaults only route advisory alerts (zero behaviour change). The `limits` YAML field is optional; existing templates validate unchanged. No new env vars, secrets, or deployment steps. Copilot control-plane tools (`PauseAgent`/`SetMissionBudget`/`NotifyUser`) that act on these alerts are the next slice.

## Sprint 24 (Phase 3) — OpenRouter cost accuracy (GitHub #10, Track 1)

Goal: make the cost figure underneath budget limits trustworthy for OpenRouter. Investigation found pi-ai 0.52.12 recomputes cost from a static table and never reads the provider-reported cost, surfaces no generation id, and offers no extra-body hook — so exact per-call OpenRouter cost is unreachable without changing pi-ai (tracked as #10 Track 2). Track 1 improves the estimate without a fork.

**`src/openrouter-pricing.ts` (new):** `fetchOpenRouterPricing()` fetches the public `GET /api/v1/models` once (in-process cache; concurrent callers share one in-flight request; failures non-fatal → empty map, keep pi-ai's estimate). `pricingFromModelsResponse(json)` (pure) converts per-token price strings → per-million numbers, skips unpriced models, and defaults cacheRead/cacheWrite to the input price (never 0) when OpenRouter doesn't report them. `applyPricingToModel(model, map)` (pure) overwrites an OpenRouter `Model`'s `cost` block in place; no-op for non-OpenRouter providers or unknown slugs. `enrichModelPricing(model)` ties them together. Constant URL (no SSRF surface), no API key, daemon-startup only.

**`src/daemon.ts`, `src/cli.ts`:** after `resolveModel`, `await enrichModelPricing(model/visionModel)`. Because the single downstream `computeCost` path reads `model.cost`, fixing it once at startup makes llmCallLog AND agentTurnStats/missionStats/limits all use the accurate rate.

**`src/llm-call-log.ts`, `src/agent-runner.ts`:** new optional `costEstimated?: boolean` on the call-log entry — `false` for first-party Anthropic (exact list price), `true` for OpenRouter (estimated; `model.provider !== "anthropic"`). Honest precision labelling for the trace viewer / billing.

**Tests:** `tests/openrouter-pricing.unit.test.ts` (8) — conversion, cache defaulting, skip-unpriced, apply-only-to-OpenRouter, no-op for unknown slug.

**Still an estimate:** Track 1 uses OpenRouter list price, not the exact amount charged for the upstream that served each request. Exact cost = #10 Track 2 (upstream pi-ai). Backward compatible: enrichment only touches OpenRouter models (Anthropic default unchanged); `costEstimated` is additive; no new env vars, secrets, or deployment steps.

## Sprint 24 (Phase 4) — Copilot intervention tools (OODA "Act")

Goal: let the copilot/operator act on the `limit-alert`s from phase 2 — pause a runaway agent, resume it, or adjust the mission budget — and surface alerts in the dashboard.

**`src/monitor-server.ts`:** new per-agent pause gate — `pausedAgents: Set<string>` + public `isAgentPaused(agentId)`. Three new token-checked POST routes (mirroring `/extend-budget`): `/pause-agent` and `/resume-agent` (validate `agentId` against the team via `readAgentId`, returning 400/404 on bad input), and `/set-budget` (absolute cap, vs `/extend-budget` which adds; lifts the budget pause when the new cap exceeds spend). `pausedAgents` added to the status payload; new SSE event types `agent-paused`/`agent-resumed`/`limit-alert`.

**`src/daemon.ts`:** wired the previously-stubbed `isAgentPaused: (agentId) => monitor.isAgentPaused(agentId)` into the orchestration config — the orchestrator already skips paused agents at dispatch (covered by orchestrator unit test TC-7).

**`packages/control-plane/src/copilot-tools.ts`, `copilot-router.ts`:** `ProposeAction` gains three action types — `pause_agent`, `resume_agent`, `set_mission_budget` — so interventions go through the established operator-confirmation flow (no silent automated action). `executeAction` handles them via a new `postToMissionMonitor` helper that resolves the mission by `{missionId, userId}`, derives the per-mission monitor token, and POSTs to the execution-plane endpoint — the same authenticated path as `write_mission_file`. `NotifyUser` was intentionally dropped (the copilot's chat already reaches the operator and the daemon already emits `limit-alert`).

**`public/index.html`, `public/app.js`:** dashboard surfaces `limit-alert` as a toast (soft = amber, auto-dismiss 12s; hard = red, sticky) with metric/threshold/label.

**Tests:** pause enforcement is covered by orchestrator TC-7 (paused agent skipped); endpoints mirror the tested `/extend-budget` pattern; both packages type-check and the full unit suite (66) passes. A live MonitorServer needs MongoDB, so the new routes are exercised via the existing dashboard integration harness rather than a new unit test.

**Backward compatibility:** all additions are new routes / action types / optional state — nothing existing changes. No new env vars, secrets, or deployment steps. Closes the Sprint 24 OODA loop: phase 1 measures, phase 2 detects + alerts, phase 4 acts.

## Sprint 25 (Phase 1) — git-commit-on-sleep

Goal: checkpoint the shared mission workspace at the end of every turn so every work product — including files written by Bash/skill scripts that the tool-call interface can't see — gets a provenance trail and is retrievable by version. Foundation for the file-content API and the Sprint 26 trace viewer's file drill-down.

**`src/workspace-git.ts` (new):** `WorkspaceGit` — one instance per mission, serializes all git operations through a single promise chain so concurrent agents finishing turns never collide on `.git/index.lock`. `commit(message)` runs `git add -A`, skips when nothing is staged (no empty-commit bloat), commits with the `magi`/`magi@magi` identity (matching `WorkspaceManager`'s init), and returns `{ commit, changedFiles }` where `changedFiles` is `diff-tree --name-status` (status letter + path). Failures are logged and return null — git tracking never breaks a mission.

**`src/agent-stats.ts`:** `AgentTurnStats` gains `gitCommit?` + `gitChangedFiles?` (status+path; captures Bash-written files that `filesWritten` from WriteFile/EditFile can't). `StatsCollector.endTurn(agentId, status, git?)` stores them on the turn doc.

**`src/agent-runner.ts`:** new `commitWorkspace?` hook on `AgentRunContext`; called in the `finally` (so an aborted turn's partial work is still checkpointed) before `endTurn`, with the result threaded into the turn stats. Best-effort — a null result just means no changes.

**`src/orchestrator.ts`:** constructs one `WorkspaceGit(firstIdentity.sharedDir)` after provision (all agents share the mission git repo) and injects `commitWorkspace` into `agentCtx`. Owned by the orchestrator because that's where `sharedDir` is resolved.

**`packages/skills/git-provenance/SKILL.md`:** rewritten — work is auto-committed at turn end; agents must NOT run `git init`/`add`/`commit` (manual commits race the automatic checkpoint and collide on the lock). The `record-work.sh` script is retained for backward compatibility but no longer referenced.

**Tests:** `tests/workspace-git.unit.test.ts` (6, real throwaway git repo) — commit new+modified with status letters and `git show <hash>:path` retrieval, null on nothing-to-commit, Bash-written file capture, serialized concurrent commits (no lock collision, linear history), graceful null on a non-repo dir.

**Backward compatibility:** new collection fields are additive; `commitWorkspace` is optional; existing missions' sharedDir is already a git repo (provision git-inits it). No new env vars, secrets, or deployment steps. **Next:** shared `document-processor.ts` + upload→process→mailbox pipeline + file-content API (`git show`).

## Sprint 25 (Phase 2) — Shared document processor + upload/download pipeline

Goal: turn uploaded files into LLM-readable artifacts, get them to agents, and let the operator download results — built on one shared processor.

**`src/document-processor.ts` (new):** `processBuffer(bytes, opts)` → artifact dir (`content.md` + extracted assets + `meta.json`). `detectFormat` (extension → magic-byte sniff → MIME). **No text truncation** — only the vision step is budgeted. `selectImages` (pure) implements the agreed describe-now/defer policy: drop decorative (both dims < 200px or aspect > 8:1), auto-describe the largest `maxAutoDescribe` (10), defer the rest with `InspectImage` pointers (dimensionless page renders are always substantive). Handlers: text/markdown, CSV (preview + full `data.csv`), image, PDF (all text; render ≤ `maxRenderPages` 50; describe ≤ 10), XLSX (exceljs → one CSV per sheet, full rows), DOCX (mammoth → markdown + embedded-image policy), ZIP (jszip → each file processed into its own artifact, nested zips listed not expanded, capped at 20). Vision call injected (`createDescribeImage(model)`) → unit-testable offline. Deps: `exceljs`, `mammoth`, `jszip`, `image-size`.

**Dedup (phase 2c):** `FetchUrl`'s PDF/image/caption logic removed (~150 lines) and routed through `processBuffer` (with `sourceUrl` for provenance); one PDF processor, one captioner, one image policy shared by fetched + uploaded files. Validated by an offline `fetch-url.unit.test.ts` that stubs `fetch` + mocks `isPrivateHost` (no whitelist in source; production SSRF unchanged).

**Upload pipeline (Slice C):** the control-plane proxy already forwards `/missions/:id/*` to the monitor with auth + token + `{missionId, userId}` scoping, so no new control-plane routes. New monitor `POST /upload` (JSON `{filename, mimeType?, agentId, subject?, body?, contentBase64}`): saves the pristine file under `uploads/<date>/`, runs `processBuffer` (vision via `monitor.visionModel`, set by the daemon) into `artifacts/`, and posts a mailbox message from `"user"` to the agent pointing at `content.md`. `readBody` parameterized with a 30 MB cap for uploads.

**Download backend (Slice D):** monitor `GET /download?path=[&format=zip]` — streams a single file (`Content-Disposition: attachment`) or zips a folder subtree (jszip, `.git` excluded); path checked within `sharedDir`. Rich download UX (multi-select, Deliverables-panel buttons) is deferred to the Sprint 26 cockpit, which consumes this endpoint.

**Deferred:** the file-content-by-commit API (`git show <hash>:<path>` for *historical* versions) is deferred to Sprint 26 with its only consumer, the trace viewer — `/download` already serves the current working tree.

**Tests:** `document-processor.unit.test.ts` (11) + `document-processor-office.unit.test.ts` (4, in-test xlsx/zip/docx fixtures) + `fetch-url.unit.test.ts` (3, offline wiring) + `monitor-files.integration.test.ts` (5: upload→artifact+mailbox, unknown-agent reject, single-file download, folder zip, path-traversal reject).

**Backward compatibility:** new module + monitor endpoints only; `visionModel` is an optional monitor field; no team-YAML change. No new env vars/secrets. New npm deps (exceljs/mammoth/jszip/image-size) are bundled into the execution image.

## Sprint 26b — Bug fixes ahead of the cockpit (markdown, mailbox, copilot wake-up)

Small fixes found while starting on the cockpit, landed before the panel work below.

- **`b8b28a5` — GFM markdown tables render.** `packages/cockpit/src/markdown.ts` had no table
  support; header/separator/data rows fell through as raw pipe-delimited text. Added
  `convertTables` (header/separator detection, `:---`/`:-:`/`---:` alignment).
- **`c95d0e7` — `PostMessage` 500 when `to` is a string.** `magi_tool.py`'s
  `post_message(to: str, ...)` sends a bare string over the tool-api-server's unvalidated raw
  HTTP path; `mailbox.ts`'s `PostMessage.execute` called `.filter()` on it directly. Now coerces
  `args.to` (string or array) to an array before use.
- **`33b5f53` — copilot wake-up messages could be silently missed.** Diagnosed from the copilot's
  own mailbox: two operator messages got no reply while others in between were answered
  promptly — an intermittent race, not a dead process. Two stacked causes, both fixed
  (belt-and-suspenders): (1) `copilot-router.ts` posted the wake-up mailbox message *after*
  calling `ensureCopilotRunning()` — on a cold start the async daemon setup (config load, skill
  provisioning, DB round-trips) could outlast the message insert, so the daemon's first
  `hasUnread()` check would sometimes race the write. Now posts before starting the daemon, so
  `hasUnread()` always finds it. (2) Even a warm daemon's Change Stream `watch()` call resolves
  "ready" before the `'change'` listener is truly attached server-side — a message posted in
  that narrow window is missed and the watch loop then waits forever on an event that already
  happened. `copilot-daemon.ts`'s `runWatchLoop` now bounds each wait to `POLL_FALLBACK_MS`
  (15 s) via a derived `AbortController`; on timeout it re-checks `listUnread()` directly instead
  of trusting the stream. Turns "a missed event hangs forever" into "self-heals within 15s."

## Sprint 26b — Turn-timeout, orphaned-job crash-loop, and data-factory concurrency fixes

Three production incidents, diagnosed and fixed live against the running `magi-control-dev` /
`magi-missions-dev` apps (Fly Machines API access unlocked mid-investigation by extracting
`access_token` from `~/.fly/config.yml`, since `flyctl auth whoami` wasn't auto-detecting it).

**Incident 1 — a turn stuck at `status:'running'` forever.** Reported as "the analyst seems
hung"; a second, older turn was also flagged `running`, which was the real tell: the system had
no way to distinguish "genuinely still working" from "the process silently stopped and nobody
told the stats layer." Root cause: only tool calls were timeout-guarded, via a `withTimeout` in
`loop.ts` that races a promise against a timer but never cancels the underlying promise. LLM
completion calls had **no** timeout at all — a provider stall left the call outstanding
indefinitely, and the turn's `agentTurnStats` doc never got a `completedAt`.

Fix, three parts:
- **`loop.ts`:** `deriveDeadline(ms, parent?)` creates a child `AbortController` that aborts on
  either the parent signal or a real timer (default `llmCallTimeoutMs = 480_000`, 8 min) — a
  genuine cancelling deadline, not `withTimeout`'s race-without-cancel. Wraps every
  `completeFn` call site (initial + 429-retry), and — because it derives from whatever signal was
  passed in — the deadline is inherited automatically by nested sub-loops (e.g. the Research
  tool's own inner loop) without each call site needing to know about it.
- **`agent-runner.ts`:** a derived-signal abort doesn't set the *outer* `signal.aborted`, so the
  existing `limitAborted || signal?.aborted` check in the turn-ending `finally` block missed this
  case. Added `lastCallAborted`, read from the last assistant message's `stopReason === "aborted"`,
  folded into the same status computation.
- **`agent-stats.ts`:** `reconcileStaleRunning(missionId, agentId, currentTurnNumber)` — defense
  in depth, called at the top of every `StatsCollector.startTurn()`. The orchestrator guarantees
  only one in-flight dispatch per agent (one `AbortController` in the `active` map, cleared in a
  `.finally()`), so if a NEW turn is starting, any OTHER `status:'running'` doc for that agent can
  only be a crash leftover — mark it `aborted`. Catches whatever the first two fixes don't (e.g.
  a daemon-level SIGKILL mid-call, not just a stalled provider).

**Incident 2 — OOM crash-loop on `magi-missions-dev`.** The Gold Digest v2 machine crashed
repeatedly; `fly logs` showed `oom_killed=true` and `"Recovered orphaned job"` firing on *every*
restart — the daemon's own OOM-recovery path was itself what kept crashing the machine.
`recoverOrphanedJobs()` (then in `daemon.ts`) had no attempt cap: a job whose own execution OOMs
the machine gets swept from `jobs/running/` back to `jobs/pending/` on the next boot, re-run,
OOMs again, swept again — forever. Fixed by extracting the function to a new
`job-recovery.ts` (needed for testability — `daemon.ts` calls `main()` unconditionally at module
load, so it can't be imported cleanly in a unit test) and adding `MAX_JOB_RECOVERY_ATTEMPTS = 2`:
past that, the job moves to `jobs/failed/`, a status file records the error, and a mailbox
message notifies the job's `notifyAgentId` (or `"user"` if unset) instead of silently requeueing.
`tests/job-recovery.unit.test.ts` (5): no-op with no `running/` dir, first-time-orphan requeue
with `recoveryAttempts:1`, permanent-fail past the cap, notify-`"user"` fallback, malformed job
file left in place rather than deleted or requeued.

**Incident 3 — the actual OOM root cause.** The crashing job was `refresh.py` (data-factory
skill), which fanned out one adapter subprocess per configured data source with no concurrency
limit — a mission with many sources launched dozens of subprocesses simultaneously, exceeding the
1 GB execution machine. Fixed in `catalog.py`: `cmd_refresh()` now runs the non-FMP adapter
fan-out through a `ThreadPoolExecutor(max_workers=max(1, max_workers))`, default
`DEFAULT_MAX_WORKERS = 5`, instead of an unbounded list of `threading.Thread`s. `refresh.py`
reads an optional `max_parallel_adapters` from `schedule.json` (same pattern as the existing
`fmp_daily_budget`) and threads it through; `schedule.json`'s default template gained the new
key. `--max-workers` CLI flag added to `catalog.py`'s `refresh` subcommand for manual runs.
`tests/data_factory/test_catalog.py::test_refresh_bounds_concurrent_adapter_subprocesses` proves
the bound with a fake `_run_adapter` that tracks peak concurrency under a lock;
`tests/data_factory/test_refresh.py::TestRunAdapters` (3) cover the `schedule.json` plumbing.

**Backward compatibility:** all additive — `MAX_JOB_RECOVERY_ATTEMPTS` and
`DEFAULT_MAX_WORKERS`/`max_parallel_adapters` have baked-in defaults, no new env vars or secrets,
no team-YAML change. `git-provenance`/mailbox/`agentTurnStats` schemas unchanged (only new
optional read paths).

## Sprint 26b — Control-plane deploy pipeline hardening

While chasing why the Trace chart (below) wasn't appearing live, found that the control-plane
machine was running an image one commit behind what CI had most recently, successfully deployed
— `flyctl machine status`'s Event Logs showed a `launch`/`user`-attributed event, not a crash,
that had silently reverted it. Root cause: `scripts/bootstrap.sh`'s control-plane deploy step runs
bare `flyctl deploy --config ... --app "$CONTROL_APP"` with no explicit `--image` and no cockpit
rebuild step first — unlike `deploy-control-plane.yml`, which always rebuilds the cockpit fresh
and deploys an explicit `:${{ github.sha }}` tag. A bare deploy run against a stale local
checkout silently ships whatever (possibly absent or outdated) cockpit build happens to be on
disk, with no error at deploy time.

Fix: added `workflow_dispatch: {}` to `deploy-control-plane.yml` (`87cacdc`) so a correct,
CI-built redeploy can always be forced on demand — `gh workflow run "Deploy control plane"` —
without depending on a path-filtered push. `docs/deployment.md` §3/§9 rewritten to warn against
bare `flyctl deploy` for the control plane (mirroring the pre-existing warning for the missions
app) and to document the diagnosis path (compare the machine's actual image sha, via
`flyctl machine status`, against `git log -1` — not the `flyctl status` summary line, which can
lag). See `docs/operational-resilience.md`'s "Recently fixed" table for the same fix from the
reliability-gap angle.

**Backward compatibility:** `workflow_dispatch` is additive to the existing `push` trigger; no
other behavior changes.

## Sprint 26b — Trace panel

Three iterations, each shipped and deployed independently, converging on the panel mocked in
`experimental/cockpit-mock.html`.

**v1 — mission-wide cost + interaction overview (`61c8c7e`).** First cut, scoped down from the
original live-trace design after explicit direction to prioritize snapshot-mode overview over
live updates ("the trace to be used more in a snapshot mode... I would prioritize a live update
of the Transcripts before than a live update of the Trace"). New monitor routes `GET
/mission-stats` (lifetime cost/calls/turns per agent, from `missionStats`), `GET /cost-series`
(per-agent per-turn cost, from `agentTurnStats`), `GET /interactions` (message counts between
agent pairs, aggregated from `mailbox`). `TracePanel.tsx`: `CostBars` (ranked horizontal bar,
sequential-blue magnitude comparison) + `InteractionHeatmap` (agent×agent grid, sequential-blue
with luminance-correct label text). Categorical (`--cat-1`..`--cat-8`) and sequential
(`--seq-100`..`--seq-700`) palette CSS vars added per the dataviz skill.

**v2 — cumulative cost-over-time chart (`53145eb`).** v1's `CostBars`/`InteractionHeatmap` were
magnitude comparisons (correctly sequential-blue per the dataviz skill), but the mock's actual
Trace chart is a multi-line "distinct series over time" chart — a different job the skill maps to
categorical color, not sequential. Corrected after the user flagged the mismatch directly against
the mock. New `CostTimeline`: per-agent step-after cumulative cost lines (cost lands in discrete
jumps at turn completion, not continuously — step-after, not interpolated), real wall-clock time
on the X axis (deviating from the mock's simplified turn-index axis, since real agents' turns
aren't chronologically aligned across agents and can be days apart), categorical per-agent color,
turn markers with tooltips, table-view toggle.

**v3 — turn bounding boxes + file/message/wakeup/anomaly marker lanes (`4c5f895`).** User
feedback after v2 shipped: "not as sophisticated as the one we mocked up" — specifically wanting
to see file writes, copilot wake-ups, scheduled-job wake-ups, anomalies, and agent messages on
the timeline, plus the mock's per-turn "bounding box" treatment. A data-source survey (via the
Explore agent) found solid existing data for three of five requested signals — file writes
(`agentTurnStats.gitChangedFiles`, from git-commit-on-sleep), agent messages (`mailbox`), and
scheduled wakeups (mailbox messages with `from:"scheduler"`) — but two real gaps: copilot
wake-ups aren't attributable to a specific mission (the copilot's `AgentRunContext` has no
`StatsCollector`, and its own activity is logged under `missionId:"copilot"`), and limit-rule
breaches aren't persisted anywhere queryable (only fired over SSE and mailed as free text to the
copilot). Per explicit direction ("let's not add to the backend for now, ship what you can with
available data"), shipped only the three with existing data, using `agentTurnStats.status ===
'aborted'` as a rough anomaly proxy instead of a real breach-reason log.

`monitor-server.ts`: extended `/cost-series`'s projection with `startedAt`, `llmCallCount`,
`peakContextTokens`, `status`, `gitChangedFiles` (all fields `agentTurnStats` already carried —
no new instrumentation); new `GET /message-events` folds the scheduler's `createdAt` field
against the mailbox's normal `timestamp` field (`$ifNull`) into one sorted per-message list,
rather than fixing that schema inconsistency at the write site (out of scope — would touch
existing read-status semantics for an unrelated visualization).

`TracePanel.tsx`: each turn now draws as a `<rect>` spanning `[startedAt, completedAt]` at the
pre-jump cost level, height scaled by `llmCallCount` (min 6px, max 22px) — a lightweight stand-in
for the mock's per-call `llmCallLog` drill-down, using only turn-level aggregates. Below the cost
plot, four marker lanes on the same time axis: Files (from `gitChangedFiles`), Messages
(non-scheduler mailbox), Wakeups (`from:"scheduler"`), Anomalies (`status:"aborted"`).

**Backward compatibility:** all additive routes/fields; existing `/cost-series` consumers
unaffected by the new projection fields. No new env vars, secrets, or deployment steps.

**Known gaps, explicitly deferred:** copilot wake-ups and real anomaly persistence would need new
backend instrumentation (see the survey above); click-to-drill-down into a turn's actual
`llmCallLog` (context-growth curve, tool sequence, files written — the mock's `turnDetail()`) is
the original Sprint 26b "historical drill-down" design and remains unbuilt — the v3 bounding
boxes approximate its visual signal (busy vs. quiet turns) without the query.

**Fetch integration tests de-flaked:** the `fetch-*.integration` tests served fixtures from `127.0.0.1`, which the SSRF guard blocked — so the agent improvised with `curl` (nondeterministic). Fixed the secure way, mirroring `BrowseWeb`: `createFetchUrlTool` gains an `allowedHosts` parameter (default `[]`), threaded test-only through `OrchestratorConfig` → `AgentRunContext`. Production (daemon/CLI) never sets it, so SSRF stays fully enforced; only the integration tests pass `["127.0.0.1"]` to reach their local fixture server. Both tests now exercise the real `FetchUrl → processBuffer` path deterministically.
