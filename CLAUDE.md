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
npm run test:integration  # integration tests — requires ANTHROPIC_API_KEY and MONGODB_URI in .env
npm run lint              # Biome check (lint + format)
npm run lint:fix          # Biome auto-fix

# CLI — run the orchestration loop with a team config
cd packages/agent-runtime-worker && npm run build   # build first
TEAM_CONFIG=config/teams/word-count.yaml npm run cli -- "count the words"
TEAM_CONFIG=config/teams/word-count.yaml npm run cli -- "count the words" --step  # pause after each agent

# Inline @path upload and /command dispatch (Sprint 3):
# At any input prompt, type:  @/path/to/file.pdf ask me about this
# /help lists available commands

# Env vars: ANTHROPIC_API_KEY (required), MONGODB_URI (required), TEAM_CONFIG (required),
#           MODEL, AGENT_WORKDIR,
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

## Current Implementation (Sprints 1–5)

Two packages are built. Key files:

**`packages/agent-config`** (Sprint 2):
- `src/loader.ts` — `loadTeamConfig(path)` / `parseTeamConfig(yaml)`: Zod schema validation; exports `AgentConfig = Record<string,string>` and `TeamConfig`. Required agent fields: `id`, `supervisor`, `systemPrompt`, `initialMentalMap`, `linuxUser`.

**`packages/agent-runtime-worker`** (Sprints 1–4):
- `src/loop.ts` — `runInnerLoop(config)`: LLM→tool→LLM loop via `completeSimple`. Terminates when the LLM stops calling tools. Fires `onMessage` after every message. `toolTimeoutMs` (default 120 s) enforced via `withTimeout` on every tool call.
- `src/tools.ts` — `createFileTools(workdir, acl: AclPolicy)`: `Bash`, `WriteFile`, `EditFile`. `AclPolicy` carries `agentId`, `permittedPaths`, and `linuxUser`. Shell tools dispatch via `runIsolatedToolCall()`: forks `sudo -u <linuxUser> node tool-executor.js` with only `PATH` and `HOME` set (no secrets in child env). `checkPath` rejects paths outside `permittedPaths` with `PolicyViolationError` before any filesystem access. Bash uses OS-level enforcement (the sudoed user has no write access to other agents' dirs). Response bodies capped at 50 MB; Bash timeout capped at 600 s. `verifyIsolation(linuxUser, workdir)`: startup invariant check — forks a child via the normal isolation path and asserts `ANTHROPIC_API_KEY` is absent; throws if sudo is misconfigured or if secrets leak.
- `src/tool-executor.ts` — clean child entry point for isolated tool execution. Launched by the orchestrator via `sudo -u <linuxUser> node dist/tool-executor.js`. Reads `ToolRequest` JSON from stdin, dispatches to `execBash` / `execWriteFile` / `execEditFile`, writes `ToolResponse` JSON to stdout, exits. Never imports anything that touches secrets.
- `src/workspace-manager.ts` — **dev stopgap.** `WorkspaceManager` creates per-agent workdirs (`homeBase/linuxUser/missions/missionId`) and the shared mission dir (`missionsBase/missionId/shared`), applies `setfacl` for mutual access. Does NOT create or delete OS users — that is the control plane's job (Sprint 6+). Exports `WorkspaceLayout` and `AgentIdentity { workdir, sharedDir, linuxUser }`. `provision(missionId, agents: Array<{ id, linuxUser }>)` creates `sharedDir/skills/_platform/`, `sharedDir/skills/_team/`, and `sharedDir/skills/mission/`; copies platform and team skill packages in; applies `r-x` setfacl on `_platform/` and `_team/` for agent users, `rwx` on `mission/`; creates `workdir/skills/` per agent; runs `git init -b main` on `sharedDir` and makes an initial commit (`chore: initialise mission workspace`) capturing the baseline workspace state.
- `src/mailbox.ts` — `MailboxRepository` (MongoDB, sort-consistent: newest-first); `PostMessage`, `ListTeam`, `ListMessages`, `ReadMessage` tools. Uses `teamConfig.mission.id` (not hardcoded). `PostMessage` validates recipient against team roster; body capped at 100 KB.
- `src/mental-map.ts` — `MentalMapRepository` (MongoDB); `UpdateMentalMap` tool; `patchMentalMap` pure function (jsdom-based, returns `null` on missing element).
- `src/artifacts.ts` — `generateArtifactId(sourceHint)`, `saveArtifact(workdir, id, files, meta)`, `saveUpload(workdir, id, files, meta)`. Internal `writeDirectory` helper keeps both paths DRY.
- `src/skills.ts` — `discoverSkills(sharedDir, workdir): SkillsBlock`: scans four tier directories in order (platform → team → mission → agent-local); extracts YAML frontmatter from each top-level `SKILL.md`; resolves name collisions (higher tier wins); returns merged skill list plus three actionable paths. Only real directories are scanned (symlinks excluded, prevents injection via `mission/`). `formatSkillsBlock(block)`: formats the block for system prompt injection.
- `src/prompt.ts` — `buildSystemPrompt(agent, mentalMapHtml, sharedDir, workdir)`: substitutes `{{mentalMap}}` in `agent.systemPrompt`, then appends the skills block produced by `discoverSkills`/`formatSkillsBlock`. `formatMessages(messages)` formats the inbox as the opening user turn.
- `src/agent-runner.ts` — `runAgent(agentId, messages, ctx, signal)`: initialises mental map, builds system prompt, derives `permittedPaths = [workdir, sharedDir]` from `AgentIdentity`, creates `AclPolicy`, runs inner loop with all tools.
- `src/orchestrator.ts` — `runOrchestrationLoop(config, signal)`: provisions workspace, then calls `verifyIsolation()` before the first cycle (fails fast if sudo is misconfigured or secrets leak); inbox-poll scheduling; runs agents in supervisor-depth order (seniors first); supports `--step` mode and live readline input; terminates when no agent has unread messages.
- `src/user-input.ts` — readline handler: `/command` dispatch (`/help`; future commands reserved under `/`); `@path` scanning (extracts `@/abs` or `@./rel` tokens, calls `saveUpload`, appends notice to message body).
- `src/cli.ts` — multi-agent CLI; requires `TEAM_CONFIG`; derives `teamSkillsPath` from the TEAM_CONFIG path (`<dir>/<basename-without-ext>/skills/`); provisions workspace via `WorkspaceManager`; registers `SearchWeb` when `BRAVE_SEARCH_API_KEY` is set; logs all tool calls and results per agent.
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
- `tests/skills.unit.test.ts` — Sprint 5: 11 unit tests for `discoverSkills` and `formatSkillsBlock`. Covers scope shadowing (mission over platform, agent over mission, team over platform), missing tier directories, malformed frontmatter, and `formatSkillsBlock` output format. No LLM, no network.
- `tests/skills.integration.test.ts` — Sprint 5: two-agent test; Lead creates `report-format` mission skill, delegates PDF analysis to Worker; Worker discovers the skill, fetches PDF via `FetchUrl`, inspects images via `InspectImage`, writes `report.md` with TLDR, commits via `git-provenance`, replies to Lead; Lead reports to user. Assertions: skill file exists, `report.md` contains TLDR, `git log` shows author "worker", user received ≥1 message. Uses `NoTeardownWorkspaceManager` subclass to preserve `sharedDir` for assertions. Config: `config/teams/skills-test.yaml`. 8-minute timeout.

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

**Sprint 5 — Skills (built):**
- No new tools. `discoverSkills(sharedDir, workdir)` scans four tiers (platform → team → mission → agent-local); `formatSkillsBlock()` injects a compact block into each agent's system prompt via `buildSystemPrompt()`. Block contains three concrete resolved paths (platform read-only, mission shared-writable, agent private-writable) and the skill list (name, scope tag, one-line description). Only top-level skills are injected; sub-skills discovered dynamically via Bash. Symlink injection prevented: only real directories scanned.
- Agents access all skills through `sharedDir/skills/` — within their existing `permittedPaths`. No dedicated skill-reader tool; `Bash` is sufficient and the only correct mechanism (scripts must run as the agent's Linux user for git identity and file ownership).
- `provision()` copies `packages/skills/` → `sharedDir/skills/_platform/` and `config/teams/{team}/skills/` → `sharedDir/skills/_team/` (if present); applies `r-x` setfacl on `_platform/` and `_team/`; creates `mission/` (rwx for all agents); creates `workdir/skills/` per agent. Runs `git init -b main` on `sharedDir` at mission startup and makes an initial commit — git is workspace infrastructure, present in every mission from day zero. The `git-provenance` skill teaches agents the **commit convention** (message format, `ledger.jsonl` via `node JSON.stringify`); its scripts do not run `git init`.
- Platform default skills in `packages/skills/`: `skill-creator`, `git-provenance`, `inter-agent-comms`
- `PublishArtifact` and `ListArtifacts` dropped — replaced by `git-provenance` skill + `git log` via Bash. See ADR-0007.

**Sprint 6 — Persistent Daemon and Conversation Persistence (built):**
- **Conversation persistence** (ADR-0008): each agent maintains a full, growing conversation across all its wakeups within a mission. `src/conversation-repository.ts` (new) provides `StoredMessage` (message + `turnNumber`), `ConversationRepository` interface, and `createMongoConversationRepository`. `InMemoryMailboxRepository` and `InMemoryMentalMapRepository` are deleted — MongoDB is the only implementation for all three repos. `runInnerLoop` gains `previousMessages?: Message[]` and returns `Message[]`. `runAgent` loads history before the loop and appends new messages after. `cli.ts` and `daemon.ts` always use MongoDB. See ADR-0008 for the `convertToLlm` filter hook (compaction placeholder) and the `turnNumber`-based `trim()` API.
- **Persistent daemon**: `runOrchestrationLoop` sleeps on MongoDB Change Stream instead of exiting when inbox is empty. Separate `daemon.ts` entry point; `cli.ts` keeps its single-run behaviour for tests. `pm2` process definition for local dev.
- **MongoDB-native operator CLI**:
  - `src/cli-post.ts` (~30 lines) — inserts one `MailboxMessage` to the `mailbox` collection and exits, waking the daemon via Change Stream. `--to <agentId>` targets any agent (default: team lead). Usage: `MISSION_ID=... npm run cli:post -- --to lead "message"` or `npm run cli:post -- --to data-scientist "re-run model"`.
  - `src/cli-tail.ts` (~30 lines) — Change Stream watch on the mailbox; prints messages as they arrive. Default: messages `to: "user"` only. `--all` flag shows full inter-agent traffic (debugging). Usage: `MISSION_ID=... npm run cli:tail` or `npm run cli:tail -- --all`.
- **MongoDB-native scheduling infrastructure** (daemon-side): `scheduled_messages` collection + `node-cron` heartbeat delivers pending documents to the mailbox; re-arms from DB on restart. The `schedule-task` skill (Sprint 7) writes to this collection directly — no HTTP needed.
- No new tools. HTTP API deferred to Sprint 10 (built alongside the frontend). `schedule-task` and `run-background` skills deferred to Sprint 7. See ADR-0007 for the token-cost criterion for skills vs. tools.

**Sprint 7 — BrowseWeb (partially built; `schedule-task` + `run-background` deferred to Sprint 8):**
- `BrowseWeb` — Playwright/Stagehand headless browser; renders JS pages; supports interactive multi-step tasks (form fill, login flows, navigation); session state (cookies, auth tokens) persists across multiple calls within the same agent turn. Conditionally registered (returns `undefined` if Playwright Chromium not installed). SSRF protection: pre-navigation regex + `dns.promises.lookup()` (DNS rebinding), post-redirect hostname check. Trust boundary markers on all results + `content.md` artifact header. Content capped at 5 MB. Stagehand LLM calls surfaced via `logger` callback.
  - `src/tools/browse-web.ts` — `BrowseWebHandle { tool, close() }` factory; `tryCreateBrowseWebTool(model, sharedDir)` returns `undefined` if Chromium absent; one Stagehand instance (lazy-init) shared across all `execute()` calls within a handle; `close()` called in `runAgent()` finally block
  - `src/agent-runner.ts` — creates `BrowseWebHandle`, registers `browseWebHandle.tool`, calls `browseWebHandle?.close()` in `finally`
  - `tests/browse-web.unit.test.ts` — SSRF regex coverage (loopback, RFC-1918, link-local, public pass-through), URL protocol validation (http/https accepted; file/ftp/javascript rejected), trust boundary marker format
  - `tests/browse-web.integration.test.ts` — Test 1: JS rendering (page with 300ms `setTimeout` content injection; asserts BrowseWeb sees rendered value, not "Loading..."); Test 2: session persistence (login call sets cookie, news call uses same cookie; asserts no "Access denied"); local HTTP server, shared `BrowseWebHandle`; 5-minute timeout; skips gracefully if Chromium absent
- `schedule-task` platform skill — deferred to Sprint 8
- `run-background` platform skill — deferred to Sprint 8

**Sprint 8 — Equity Research Team MVP:**
- Four-agent team tracking NVDA: Lead Analyst (supervisor: user), Economist (supervisor: lead), Junior Analyst (supervisor: lead), Data Scientist (supervisor: lead). Ticker hardcoded in team YAML.
- Bootstrap phase (operator-guided, 3 steps): Step 1 — operator posts kick-off to all agents simultaneously (mission context, think about your role, proposals requested); Step 2 — operator prompts each agent individually for their proposal (scope, sources, infrastructure, inter-agent dependencies), reviews, may ask follow-ups; Step 3 — operator sends approval to Lead, who coordinates the infrastructure build, Data Scientist commits tracker + scripts, Lead registers the 06:00 daily trigger via `schedule-task` and confirms to user.
- Daily cycle (once bootstrapped): `schedule-task` fires at 06:00 → Lead wakes → tasks Economist, Junior, Data Scientist → each does research / data collection → Lead synthesises → commits daily brief → posts summary to user.
- Deliverables:
  - `config/teams/equity-research.yaml` — team config with NVDA ticker in mission params
  - Role system prompts and Mental Map section templates for each of the four agents
  - `packages/skills/schedule-task/` — platform skill (deferred from Sprint 7): writes a cron entry to `scheduled_messages` collection; triggers timed agent wakeups via the Sprint 6 node-cron heartbeat
  - `config/teams/equity-research/skills/daily-brief-template/` — team skill: brief structure (macro snapshot / sector view / company view / recommendation / confidence / tracker link)
  - `sharedDir/tracker.csv` — performance tracker; columns: `date, ticker, recommendation, rationale_commit, entry_price, exit_price, pnl`; Data Scientist initialises and maintains
  - Daily brief committed to `sharedDir/briefs/YYYY-MM-DD.md` with source citations
- Exit criteria: (1) all four agents produce coherent individual proposals in Step 2; (2) Data Scientist commits tracker + at least one data collection script after Step 3 approval; (3) Lead registers 06:00 schedule and confirms to user; (4) full daily cycle completes: research committed → brief committed → user receives PostMessage with L/S recommendation, macro/sector/company rationale

## Sprint Roadmap

| Sprint | Status | Focus |
|--------|--------|-------|
| 0 | ✅ Done | Architecture freeze: six ADRs in `docs/adr/` |
| 1 | ✅ Done | Inner loop: `runInnerLoop`, 3 tools, MongoDB persistence, CLI, integration test |
| 2 | ✅ Done | Multi-agent: YAML team config (Zod), mailbox, orchestration loop, supervisor-depth ordering, 5 tools |
| 3 | ✅ Done | Web search, fetch, artifacts: `FetchUrl`, `InspectImage`, `SearchWeb`; `@path` upload; artifact model |
| 4 | ✅ Done | Identity, workspace, ACL enforcement: OS-isolated tool execution, `AclPolicy`, `WorkspaceManager`, `tool-executor.ts` (Temporal + Redis dropped — see ADRs 0001, 0006) |
| 5 | ✅ Done | Agent Skills: discovery, 3 platform defaults (`skill-creator`, `git-provenance`, `inter-agent-comms`); Bash-based access via sharedDir copy; `provision()` runs `git init` |
| 6 | ✅ Done | Persistent daemon (MongoDB Change Stream sleep), conversation persistence (ADR-0008), MongoDB-native scheduling infra + `cli:post` |
| 7 | ✅ Done | `BrowseWeb` (Stagehand/Playwright): JS rendering, interactive tasks, session persistence, SSRF blocking, trust boundary markers |
| 8 | | Equity research MVP: 4-agent NVDA team, `schedule-task` skill, bootstrapping mission, daily brief + L/S rec + performance tracker |
| 9 | | Reliability + evaluation harness (5-day unattended run) |
| 10 | | Work Product Layer UI |
| 11 | | Cloud burst and scale-out |
| 12 | | Hardening and launch prep |
| 13 | | Mission Assistant: LLM operator copilot with read access to all mission state |

## Development Principles

**No fallbacks to accommodate tests.** When a sprint introduces a hard requirement (e.g. every agent must declare a `linuxUser`), do not make the requirement optional in production code because earlier tests predate the feature. Update the tests instead. Code that silently degrades — optional fields, `?? default` catch-alls, skipped-if-missing checks — written specifically so old tests keep passing is bad debt and will be rejected in review. The rule is simple: fix the test, not the production code.

**No optional security.** Security properties (identity, ACL, OS isolation) are never opt-in or conditional. If a field is required for correct operation, it is `required` in the TypeScript type and in the Zod schema. There is no fallback mode, no in-process degradation, no silent omission. If a test cannot satisfy the requirement, the test must be updated, not the requirement weakened.

## Testing Approach

Three tiers — apply the right one to the right layer:

- **Unit tests** — pure, deterministic logic only: config validation, ACL policy evaluation, `UpdateMentalMap` HTML patching. `npm test`, no LLM calls, no network.
- **Integration tests** — real LLM calls with carefully chosen prompts whose outcomes are deterministic. Tests the full stack end-to-end including tool execution and persistence. `npm run test:integration` — requires `ANTHROPIC_API_KEY` and `MONGODB_URI` in `.env`. Each test uses a unique `missionId`; `afterEach` cleans up via `deleteMany({ missionId })` on all MongoDB collections. Current scenarios:
  - Sprint 1: single agent finds `greeting.txt` (contains "HELLO WORLD") and appends "GOODBYE".
  - Sprint 2: two-agent word count — Lead delegates to Worker via mailbox; Worker runs `wc -w`, replies; Lead reports the total (12) to user. Config loaded from `config/teams/word-count.yaml`. Assertion: Lead's final message contains "12".
  - Sprint 3a: single agent fetches a local HTML page (served from `testdata/documents/`) containing a cat image; calls `InspectImage`; asserts "cat" or "feline" in user message.
  - Sprint 3b: two agents share a PDF artifact — Lead fetches PDF, Worker reads images via Bash and `InspectImage`; asserts one artifact folder and both "dog" and "cat" in user message.
  - Sprint 3c: real web search — searches "Pale Blue Dot Voyager NASA", fetches Wikipedia top result, inspects photograph; asserts Voyager/Sagan content and image description. Skipped when `BRAVE_SEARCH_API_KEY` absent. 4-minute timeout.
  - Sprint 6a: conversation persistence — extends the word-count test; after Lead reports "12" to user, queries `conversationMessages` collection directly and asserts `turnNumber: 0` and `turnNumber: 1` documents exist for Lead with correct message types (tool calls and results included).
  - Sprint 6b: daemon wake-up — spawns `daemon.ts` subprocess; injects first user message via `cli:post`; polls mailbox until Lead replies to user; asserts reply received within timeout. Requires `MONGODB_URI`. 2-minute timeout.
  - Sprint 5: two-agent skills test — Lead creates `report-format` mission skill; Worker discovers it, fetches test PDF, writes `report.md` with TLDR, commits via `git-provenance`, reports to Lead; Lead reports to user. Assertions: skill file, TLDR in report, "worker" in `git log`, user message. Config: `config/teams/skills-test.yaml`. 8-minute timeout.
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

## Known Pitfalls

**sudo prompts appearing in the daemon terminal**
Agents occasionally generate Bash commands containing `sudo` (e.g. `sudo apt install …`). The tool executes as the pool user (`magi-wN`) which has no sudoers entry. By default `sudo` authenticates via PAM *before* checking authorization, producing a password prompt on the daemon's controlling terminal even though the command will ultimately be denied.

Fix: `/etc/sudoers.d/magi` must include `Defaults:%magi-shared !authenticate`. This skips PAM for the group; the command still fails (no allowing rule), but fails silently. Applied by `scripts/setup-dev.sh` — re-run it if you see prompts:
```bash
sudo scripts/setup-dev.sh
```

**Node binary path wrong in sudoers (nvm users)**
`setup-dev.sh` bakes the absolute path of `node` into the sudoers rule (`NOPASSWD: /path/to/node`). When run with plain `sudo`, sudo strips nvm from PATH so `which node` resolves to the system binary (e.g. `/usr/bin/node`), not the nvm-managed one the daemon actually uses. The sudoers rule ends up wrong and every daemon start will prompt for a password then time out.

Always run setup-dev.sh with the nvm node path passed explicitly:
```bash
sudo env NODE_BIN=$(which node) scripts/setup-dev.sh
```

**Port 4000 already in use on daemon start**
A previous daemon instance may still hold the port. Find and kill it:
```bash
lsof -ti tcp:4000 | xargs kill -9
```

**`File is not defined` on Node 18 (Stagehand / undici)**
`undici` checks for the `File` global at module load. Node 18 doesn't expose it globally. The daemon entry point uses `--import ./dist/node-polyfill.js` to polyfill it before any imports. If you see this error from a different entry point, add the same `--import` flag.

**`cron-parser` named export error on Node 18/22**
`import { parseExpression } from "cron-parser"` fails because the package ships CJS. Use the default import:
```typescript
import cronParser from "cron-parser";
const { parseExpression } = cronParser;
```

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
