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
