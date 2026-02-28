# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MAGI V3 is an autonomous multi-agent system where teams of AI agents run long-horizon research and operations missions. The primary anchor use case is an **equity research team** (Lead Analyst, Junior Analysts, Data Scientists, Watcher/Alert agents) that produces daily market briefs, weekly sector reports, and event-driven alerts with source citations.

The system builds on MAGI v2's autonomous loop, tool system, and stateless architecture. V3's main additions are: durable orchestration, sandboxed execution, and multi-agent coordination.

**Key documents:**
- [MAGI_V3_SPEC.md](MAGI_V3_SPEC.md) — full technical specification (agent loop, Mental Map, prompt construction, tool system, Temporal model, identity, mailbox, artifacts)
- [MAGI_V3_ROADMAP.md](MAGI_V3_ROADMAP.md) — sprint roadmap (backend-first; 9 sprints to launch)
- [MAGI_V3_USE_CASE_PORTFOLIO.md](MAGI_V3_USE_CASE_PORTFOLIO.md) — 11 use case definitions

## Commands

```bash
npm run build             # compile all packages (tsc)
npm test                  # unit tests (no LLM calls, no network)
npm run test:integration  # integration tests — requires ANTHROPIC_API_KEY in .env
npm run lint              # Biome check (lint + format)
npm run lint:fix          # Biome auto-fix

# CLI — run the orchestration loop with a team config
cd packages/agent-runtime-worker && npm run build   # build first
TEAM_CONFIG=config/teams/word-count.yaml npm run cli -- "count the words"
TEAM_CONFIG=config/teams/word-count.yaml npm run cli -- "count the words" --step  # pause after each agent

# Inline @path upload and /command dispatch (Sprint 3):
# At any input prompt, type:  @/path/to/file.pdf ask me about this
# /help lists available commands

# Env vars: ANTHROPIC_API_KEY (required), TEAM_CONFIG (required),
#           MODEL, MONGODB_URI, AGENT_WORKDIR,
#           BRAVE_SEARCH_API_KEY (optional — enables SearchWeb tool; free tier: 2000 req/month)
```

Type-check without building:
```bash
npx tsc -p packages/agent-runtime-worker/tsconfig.json --noEmit
```

## Architecture

### Control Plane + Execution Plane split

**Control Plane** (stable, changes slowly):
- `mission-api` — create/update missions, team composition, mandates, policies
- `orchestrator` — Temporal workflows for all agent lifecycles (retries, heartbeats, pause/resume, schedules)
- `identity-access-service` — agent identities, roles, uid/gid mapping, folder ACL policy
- `mailbox-service` — durable inter-agent messaging and task routing via Redis Streams
- `artifact-promotion-service` — controlled dev-to-prod release path (Sprint 5+)
- `state-store` — MongoDB for conversation/history/memory with indexed event records
- `observability` — OpenTelemetry traces/metrics/log correlation

**Execution Plane** (evolvable backends):
- `agent-runtime-worker` — executes LLM turns and tool selection logic
- `workspace-manager` — provisions agent home dirs and shared mission folders with ACL templates
- `execution-runner` — shared worker pool + isolated per-agent/per-env execution pools
- `browser-runner` — Playwright-based browsing/download pipeline
- `data-processing-runner` — parsers, ETL, feature extraction, analytics jobs
- `artifact-store` — MinIO (local) / S3-compatible (cloud) object storage

### Agent Identity Model

Each agent has a two-layer identity:
- `agent_id` — semantic MAGI identity (e.g. `lead-analyst`), stable across missions
- `linux_user` — OS user assigned at mission startup. In **production**, the control plane creates one dedicated OS user per agent per mission. In **dev**, pre-existing users (`magi-w1`, `magi-w2`, …) from `scripts/setup-dev.sh` are reused across missions; the `linuxUser` field in the team YAML is a dev stopgap and will not exist in the production model (the control plane assigns it).
- Role, policy tags, `permittedPaths`, `permittedTools` stored in MongoDB `agent_identities`
- Per-agent private home: `/home/{linux_user}/missions/{mission_id}/`
- Shared mission folder: `/missions/{mission_id}/shared/`
- Each mission deploys as a **single container**; all agents share the container but are isolated from each other via Linux ACLs (`setfacl`) on their private workdirs.
- `dev` and `prod` workspaces are isolated; cross-environment exchange only via promoted artifacts

`WorkspaceManager` (`src/workspace-manager.ts`) is a dev stopgap: creates per-agent workdirs and the shared mission dir, applies `setfacl`, but does NOT create or delete OS users — that is the control plane's job (Sprint 6+).

Low-risk orchestration tasks run in shared runtime workers. Code execution, data processing, and browser automation run in the agent's assigned execution environment with their persistent home and allowed shared folders mounted.

**Sprint 2 implementation:** Single unified agent loop — no outer/inner split. `runAgent(agentId, messages, ctx, signal)` is the only function the orchestrator calls. The orchestrator pre-fetches unread messages from the mailbox, marks them as read, builds the system prompt by substituting `{{mentalMap}}` into `agent.systemPrompt` (read from YAML), passes messages as the opening user turn, and runs one LLM→tool→LLM sequence with all tools available.

Each agent has a `supervisor` field (another agent's id, or `"user"`); agents escalate by calling `PostMessage` to their supervisor. The orchestration loop is inbox-poll scheduled: agents run in supervisor-depth order (depth 0 = reports to user; seniors always run before juniors within a cycle). The mission turn ends when no agent has unread messages. The CLI supports buffered readline injection for live user input, a `--step` flag for pause-and-inspect mode, and Ctrl+C abort via `AbortSignal`.

### Agent Communication

Agents communicate with structured, durable mailbox messages (not free-form chat). Message schema:
- `mission_id`, `sender_agent_id`, `recipient_role|agent_id`
- `intent`: `task_request`, `data_request`, `result_submit`, `risk_alert`
- `artifact_refs`, `deadline`, `priority`, `status`

Agents share artifact references (datasets, code patches, notebooks, charts, reports, alert payloads), not raw data.

## Current Implementation (Sprints 1–4)

Two packages are built. Key files:

**`packages/agent-config`** (Sprint 2):
- `src/loader.ts` — `loadTeamConfig(path)` / `parseTeamConfig(yaml)`: Zod schema validation; exports `AgentConfig = Record<string,string>` and `TeamConfig`. Required agent fields: `id`, `supervisor`, `systemPrompt`, `initialMentalMap`, `linuxUser`.

**`packages/agent-runtime-worker`** (Sprints 1–4):
- `src/loop.ts` — `runInnerLoop(config)`: LLM→tool→LLM loop via `completeSimple`. Terminates when the LLM stops calling tools. Fires `onMessage` after every message. `toolTimeoutMs` (default 120 s) enforced via `withTimeout` on every tool call.
- `src/tools.ts` — `createFileTools(workdir, acl: AclPolicy)`: `Bash`, `WriteFile`, `EditFile`. `AclPolicy` carries `agentId`, `permittedPaths`, and `linuxUser`. Shell tools dispatch via `runIsolatedToolCall()`: forks `sudo -u <linuxUser> node tool-executor.js` with only `PATH` and `HOME` set (no secrets in child env). `checkPath` rejects paths outside `permittedPaths` with `PolicyViolationError` before any filesystem access. Bash uses OS-level enforcement (the sudoed user has no write access to other agents' dirs). Response bodies capped at 50 MB; Bash timeout capped at 600 s. `verifyIsolation(linuxUser, workdir)`: startup invariant check — forks a child via the normal isolation path and asserts `ANTHROPIC_API_KEY` is absent; throws if sudo is misconfigured or if secrets leak.
- `src/tool-executor.ts` — clean child entry point for isolated tool execution. Launched by the orchestrator via `sudo -u <linuxUser> node dist/tool-executor.js`. Reads `ToolRequest` JSON from stdin, dispatches to `execBash` / `execWriteFile` / `execEditFile`, writes `ToolResponse` JSON to stdout, exits. Never imports anything that touches secrets.
- `src/workspace-manager.ts` — **dev stopgap.** `WorkspaceManager` creates per-agent workdirs (`homeBase/linuxUser/missions/missionId`) and the shared mission dir (`missionsBase/missionId/shared`), applies `setfacl` for mutual access. Does NOT create or delete OS users — that is the control plane's job (Sprint 6+). Exports `WorkspaceLayout` and `AgentIdentity { workdir, sharedDir, linuxUser }`.
- `src/mailbox.ts` — `MailboxRepository` (in-memory + MongoDB, sort-consistent: newest-first); `PostMessage`, `ListTeam`, `ListMessages`, `ReadMessage` tools. Uses `teamConfig.mission.id` (not hardcoded). `PostMessage` validates recipient against team roster; body capped at 100 KB.
- `src/mental-map.ts` — `MentalMapRepository` (in-memory + MongoDB); `UpdateMentalMap` tool; `patchMentalMap` pure function (jsdom-based, returns `null` on missing element).
- `src/artifacts.ts` — `generateArtifactId(sourceHint)`, `saveArtifact(workdir, id, files, meta)`, `saveUpload(workdir, id, files, meta)`. Internal `writeDirectory` helper keeps both paths DRY.
- `src/prompt.ts` — `buildSystemPrompt(agent, mentalMapHtml)`: substitutes `{{mentalMap}}` in `agent.systemPrompt`. `formatMessages(messages)` formats the inbox as the opening user turn.
- `src/agent-runner.ts` — `runAgent(agentId, messages, ctx, signal)`: initialises mental map, builds system prompt, derives `permittedPaths = [workdir, sharedDir]` from `AgentIdentity`, creates `AclPolicy`, runs inner loop with all tools.
- `src/orchestrator.ts` — `runOrchestrationLoop(config, signal)`: provisions workspace, then calls `verifyIsolation()` before the first cycle (fails fast if sudo is misconfigured or secrets leak); inbox-poll scheduling; runs agents in supervisor-depth order (seniors first); supports `--step` mode and live readline input; terminates when no agent has unread messages.
- `src/user-input.ts` — readline handler: `/command` dispatch (`/help`; future commands reserved under `/`); `@path` scanning (extracts `@/abs` or `@./rel` tokens, calls `saveUpload`, appends notice to message body).
- `src/cli.ts` — multi-agent CLI; requires `TEAM_CONFIG`; provisions workspace via `WorkspaceManager`; registers `SearchWeb` when `BRAVE_SEARCH_API_KEY` is set; logs all tool calls and results per agent.
- `src/models.ts` — `CLAUDE_SONNET` constant; `anthropicModel()` factory.
- `src/tools/fetch-url.ts` — `createFetchUrlTool(model, sharedDir)`: HTTP GET → Readability (HTML) or mupdf (PDF) → `content.md`; downloads up to `max_images` images (default 3, max 10) from article body only (not nav/UI); vision LLM auto-describes each image; writes artifact folder + `meta.json`. `max_pages` (default 5, max 20) limits PDF processing. VISION_MIMES: jpeg, png, gif, webp only (SVG excluded). `file://` URLs rejected (LFI fix).
- `src/tools/inspect-image.ts` — `createInspectImageTool(workdir, model)`: reads image file (path resolved within workdir — path traversal rejected), base64-encodes it, calls vision LLM via `completeSimple`.
- `src/tools/search-web.ts` — `createSearchWebTool(apiKey)`: Brave Search REST API → ranked markdown result list; saves results as an artifact; not registered when key absent.
- `tests/loop.integration.test.ts` — Sprint 1: real LLM finds and edits `greeting.txt`.
- `tests/multi-agent.integration.test.ts` — Sprint 2/4: Lead delegates word-count to Worker; asserts Lead reports "12" to user. Uses real pool users `magi-w1`/`magi-w2`; seeds `greeting.txt` in Worker's workdir; applies setfacl. Loads config from `config/teams/word-count.yaml`.
- `tests/fetch-inspect.integration.test.ts` — Sprint 3: single agent fetches a local HTML page with an image, inspects it; asserts "cat" or "feline" in summary.
- `tests/fetch-share.integration.test.ts` — Sprint 3/4: two-agent test; Lead fetches a PDF, Worker analyses images via Bash; asserts one artifact folder and both animal species in user message. Uses real pool users.
- `tests/search-web.integration.test.ts` — Sprint 3: searches "Pale Blue Dot Voyager NASA", fetches Wikipedia top result, inspects photograph; skipped when `BRAVE_SEARCH_API_KEY` absent.
- `tests/acl.integration.test.ts` — Sprint 4: verifies ACL enforcement without LLM. (1) `WriteFile` to another agent's private dir → `PolicyViolationError`. (2) `Bash` writing to another agent's private dir → OS-level `Permission denied`. Uses real pool users `magi-w1`/`magi-w2`, temp workdirs, and setfacl.

## Tool Capabilities (Implementation Priority Order)

**Sprints 1–3 — built:**
- `Bash`, `WriteFile`, `EditFile` — file and shell work
- `PostMessage` — send to one or more agent ids (or `"user"` to reach the operator)
- `UpdateMentalMap` — surgical HTML patching of the agent's Mental Map document (jsdom-based)
- `ListTeam` — read agent roster from team config: id, name, role, supervisor
- `ListMessages` — inbox headers for older messages: from, subject, timestamp
- `ReadMessage` — read full older message by id
- `FetchUrl` — HTTP GET → Readability (HTML) or mupdf (PDF) extraction; image download; artifact folder; vision auto-describe
- `InspectImage` — pass any image file to the vision LLM; returns text description; path traversal safe
- `SearchWeb` — Brave Search API; ranked result list; artifact saved; conditionally registered

**Sprint 5 — Skills (planned):**
- No new tools. Skill discovery added to `buildSystemPrompt()`: scans four tiers (platform → team → mission → agent-local), injects compact metadata block (~100 tokens/skill). Agents use existing `Bash` to read `SKILL.md` and run scripts.
- Platform default skills in `packages/skills/`: `skill-creator`, `git-provenance`, `inter-agent-comms`
- `PublishArtifact` and `ListArtifacts` dropped — replaced by `git-provenance` skill + `git log` via Bash. See ADR-0007.

**Sprint 6 — Orchestrator as a Service (planned):**
- No new tools. `ScheduleMessage`/`CancelSchedule`/`RunBackground` are skills, not tools (token-cost criterion: used O(1) times per mission vs O(50) LLM calls — see ADR-0007).
- Two new platform skills ship this sprint (depend on HTTP API): `schedule-task`, `run-background`

**Sprint 7 (planned):**
- `BrowseWeb` — Playwright headless browser; renders JS before extraction; same artifact convention as `FetchUrl`; conditionally registered

## Sprint Roadmap

| Sprint | Status | Focus |
|--------|--------|-------|
| 0 | ✅ Done | Architecture freeze: six ADRs in `docs/adr/` |
| 1 | ✅ Done | Inner loop: `runInnerLoop`, 3 tools, MongoDB persistence, CLI, integration test |
| 2 | ✅ Done | Multi-agent: YAML team config (Zod), mailbox, orchestration loop, supervisor-depth ordering, 5 tools |
| 3 | ✅ Done | Web search, fetch, artifacts: `FetchUrl`, `InspectImage`, `SearchWeb`; `@path` upload; artifact model |
| 4 | ✅ Done | Identity, workspace, ACL enforcement: OS-isolated tool execution, `AclPolicy`, `WorkspaceManager`, `tool-executor.ts` (Temporal + Redis dropped — see ADRs 0001, 0006) |
| 5 | | Agent Skills: discovery, 3 platform defaults (`skill-creator`, `git-provenance`, `inter-agent-comms`), git workspace |
| 6 | | Orchestrator as a service: persistent daemon, Mission HTTP API, `schedule-task` + `run-background` skills |
| 7 | | `BrowseWeb` (Playwright) |
| 8 | | Equity research team MVP |
| 9 | | Reliability + evaluation harness (5-day unattended run) |
| 10 | | Work Product Layer UI |
| 11 | | Cloud burst and scale-out |
| 12 | | Hardening and launch prep |

## Development Principles

**No fallbacks to accommodate tests.** When a sprint introduces a hard requirement (e.g. every agent must declare a `linuxUser`), do not make the requirement optional in production code because earlier tests predate the feature. Update the tests instead. Code that silently degrades — optional fields, `?? default` catch-alls, skipped-if-missing checks — written specifically so old tests keep passing is bad debt and will be rejected in review. The rule is simple: fix the test, not the production code.

**No optional security.** Security properties (identity, ACL, OS isolation) are never opt-in or conditional. If a field is required for correct operation, it is `required` in the TypeScript type and in the Zod schema. There is no fallback mode, no in-process degradation, no silent omission. If a test cannot satisfy the requirement, the test must be updated, not the requirement weakened.

## Testing Approach

Three tiers — apply the right one to the right layer:

- **Unit tests** — pure, deterministic logic only: config validation, ACL policy evaluation, `UpdateMentalMap` HTML patching. `npm test`, no LLM calls, no network.
- **Integration tests** — real LLM calls with carefully chosen prompts whose outcomes are deterministic. Tests the full stack end-to-end including tool execution and persistence. `npm run test:integration` — requires `ANTHROPIC_API_KEY` in `.env`. Current scenarios:
  - Sprint 1: single agent finds `greeting.txt` (contains "HELLO WORLD") and appends "GOODBYE".
  - Sprint 2: two-agent word count — Lead delegates to Worker via mailbox; Worker runs `wc -w`, replies; Lead reports the total (12) to user. Config loaded from `config/teams/word-count.yaml`. Assertion: Lead's final message contains "12".
  - Sprint 3a: single agent fetches a local HTML page (served from `testdata/documents/`) containing a cat image; calls `InspectImage`; asserts "cat" or "feline" in user message.
  - Sprint 3b: two agents share a PDF artifact — Lead fetches PDF, Worker reads images via Bash and `InspectImage`; asserts one artifact folder and both "dog" and "cat" in user message.
  - Sprint 3c: real web search — searches "Pale Blue Dot Voyager NASA", fetches Wikipedia top result, inspects photograph; asserts Voyager/Sagan content and image description. Skipped when `BRAVE_SEARCH_API_KEY` absent. 4-minute timeout.
- **Evaluation tests** (`eval/`) — golden scenarios asserting structural/policy outcomes (citation coverage, `nextAction` validity, policy enforcement), not content. Run on demand, not in CI.

Test runner: **vitest** — native ESM, no build step needed. Config: `vitest.config.ts` (unit), `vitest.integration.config.ts` (integration). Setup file: `vitest.setup.ts` loads `.env` and polyfills `File` for Node 18.

Do not write unit or integration tests for: prompt wording, LLM tool selection choices, or report content quality — those belong in the evaluation harness.

## Configuration-First Approach (Portfolio and Team Design)

Until Portfolio/Team Design UIs ship, all configuration is done through validated YAML files:
- Portfolio configs: `config/portfolios/*.yaml`
- Team design configs: `config/teams/*.yaml`

Required support: schema validation + linting, dry-run compile to runtime policy objects, config diff/change history for auditability.

## UI Layer Priority

Build in this order:
1. **Work Product Layer** (first): Mission Inbox, Report Center, Alert Center, Ask Console, Evidence Explorer
2. **Portfolio Layer** (deferred): manage teams, mandates, health, budgets
3. **Team Design Layer** (deferred): agent roster, role-capability matrix, routing, ACL editing

Evaluate `pi-mono/packages/web-ui` vs MAG_v2 frontend reuse for the Work Product Layer. Decision rule: adopt `pi-web-ui` if it integrates cleanly and accelerates delivery; otherwise use MAG_v2 as primary.

## Key Architecture Decisions (Sprint 0)

Pending final decisions at Sprint 0:
1. Orchestration engine: Temporal vs queue-first stopgap
2. Runtime topology: shared workers vs dedicated isolated pools per role
3. Identity and ACL model: Linux users/groups/ACL + cloud-equivalent enforcement
4. Cross-container communication contract: addressing, retry, ordering, ack semantics
5. Frontend path: MAG_v2 UI reuse vs `pi-web-ui` scope
6. Artifact storage backend: MinIO locally, S3-compatible in cloud

## Quality Requirements

- Every claim in a report requires source references and links to evidence lineage in the UI
- Confidence scores required for forecasts
- Conflicting signals force a review task (no silent averaging)
- Alert actions (`ack`, `escalate`, `snooze`) must be durable and auditable
- Permission denials must be visible and actionable, not silent failures

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript throughout (backend, frontend, tooling) |
| Process supervision | pm2 (local dev) / systemd (server); node-cron for scheduling (Temporal dropped — see ADR-0001) |
| Browser automation | Playwright |
| Object storage | MinIO (local) / S3-compatible (cloud) |
| State store / memory | MongoDB |
| Messaging / streams | Redis Streams with consumer groups |
| Observability | OpenTelemetry (traces, metrics, logs) |
| Container isolation | Docker rootless + seccomp, or gVisor / Firecracker |
| Cloud scale-out | Kubernetes (namespaces, Jobs, CronJobs, Pod Security Standards) |
| Filesystem permissions | Linux ACLs (`setfacl`) |

## MAGI v2 Baseline (`refs/MAG_v2` → `/home/remyh/ml/MAGI_v2/MAG_v2`)

V3 reuses V2's agent loop logic as Temporal worker activities rather than rewriting from scratch. Key V2 patterns to carry forward:

**Stack**: TypeScript monorepo (npm workspaces) — `backend/` (Node.js/Express), `frontend/` (Vue.js), `packages/shared-types/`.

**Dev commands** (run from repo root):
```
npm run dev      # start backend + frontend + types concurrently
npm run build    # build types → frontend → backend
npm test         # backend integration tests
npm run lint     # ESLint on all workspaces
```

**Stateless backend pattern**: On every request, the entire conversation history is reloaded from MongoDB, state is reconstructed, processing occurs, results are persisted, and session state is discarded. This enables horizontal scaling and consistency across restarts. V3 should preserve this principle — Temporal workers are stateless; all durable state lives in MongoDB and the Temporal workflow history.

**Agent loop**: Iterative LLM → tool → LLM cycles streamed to the frontend via SSE. The loop runs until a completion condition is met or max turns is reached. Tool calls are executed sequentially; each call + result is saved to MongoDB and broadcast to the frontend before the next LLM call.

**Existing tools in V2** (defined in `backend/src/services/tools/`):
- `Editor` — modifies the Mental Map Document (shared HTML doc with id-targeted elements)
- `ResearchTool` / `LibrarianTool` — RAG-based document search
- `CritiqueTool` — self-assessment / reflection
- `WebSearchService`, `FetchService` — web search and content fetch
- `InspectImageTool`, `ImageGenerationTool` — vision and image generation
- `SubAgentService` — sub-agent delegation pattern

**Multi-LLM abstraction**: `backend/src/services/llm/` wraps OpenAI, Anthropic Claude, Google Vertex AI (Gemini), TogetherAI, and HuggingFace behind a unified provider interface.

**Design docs** (in `refs/MAG_v2/`):
- `DESIGN-ARCHITECTURE.md` — stateless backend, Mental Map concept, SSE patterns
- `DESIGN-AGENT-SYSTEM.md` — agent loop, tool integration, completion detection, sub-agents
- `DESIGN-LLM-INTEGRATION.md` — multi-provider abstraction, structured output, prompt engineering
- `DESIGN-DATA.md` — MongoDB schemas, vector search, rollback system
- `DESIGN-FRONTEND.md` — Vue.js client, SSE integration, Mental Map UI

## pi-mono (`refs/pi-mono` → `/home/remyh/ml/MAGI_v2/pi-mono`)

A separate TypeScript monorepo with reusable AI agent primitives. Two packages are strong candidates for direct use in V3:

**`@mariozechner/pi-agent-core`** (`packages/agent/`) — production-ready agent loop with streaming, mid-run steering, follow-up messages, abort signals, and context window compaction. Planned adoption in a later sprint when those capabilities are needed; Sprint 1 uses `@mariozechner/pi-ai` directly (see below).

**`@mariozechner/pi-ai`** (`packages/ai/`) — used directly in Sprint 1: `completeSimple(model, context, options?) => Promise<AssistantMessage>` is the non-streaming LLM call used by `runInnerLoop`.

**`@mariozechner/pi-web-ui`** (`packages/web-ui/`) — Lit-based web components for AI chat UIs:
- `<pi-chat-panel>` — top-level shell: wires agent, artifacts panel, and interface together; responsive (overlay vs side-by-side at 800px breakpoint)
- `<agent-interface>` — input area with attachments, model selector, thinking level selector
- `<message-list>` + message components: `UserMessage`, `AssistantMessage`, `ToolMessage`, `ThinkingBlock`, `StreamingMessageContainer`
- Artifact rendering: `ArtifactsPanel`, `HtmlArtifact`, `MarkdownArtifact`, `ImageArtifact`, `SvgArtifact`, `TextArtifact`
- Tool renderer registry: `registerToolRenderer("toolName", renderer)` — pluggable per-tool result display
- Dialogs: `ModelSelector`, `SessionListDialog`, `SettingsDialog`, `ApiKeyPromptDialog`
- Storage: `SessionsStore`, `ProviderKeysStore`, `SettingsStore` backed by IndexedDB

**`@mariozechner/pi-ai`** (`packages/ai/`) — unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) with `completeSimple`, `streamSimple`, and `EventStream` primitives.

**Build commands** (run from `refs/pi-mono/`):
```
npm install       # install all dependencies
npm run build     # build all packages
npm run check     # lint, format, type-check (requires build first)
./test.sh         # run tests (skips LLM-dependent tests without API keys)
```
