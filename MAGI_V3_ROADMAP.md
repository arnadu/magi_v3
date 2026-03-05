# MAGI V3 Roadmap

## Objective

Build an autonomous multi-agent system that can write and run code, browse the web, process data, run agents in parallel, and let agents communicate and coordinate on shared missions.

Primary anchor scenario: an equity research team producing daily market briefs, weekly sector reports, and event-driven alerts with full citation lineage.

## Guiding Principle: Backend First

The UI is deferred until the backend is solid and delivering real value. The first eight sprints produce a working, observable multi-agent backend with no frontend beyond raw API responses and log output. A minimal Work Product UI follows only once the core loop, orchestration, and multi-agent coordination are proven.

This ordering avoids building UI on top of a shifting foundation, and forces the architecture to be clean before it is wrapped.

---

## Sprint 0 — Architecture Freeze ✅ COMPLETED

Deliverables completed:
- Six Architecture Decision Records in `docs/adr/`:
  - ADR-0001: Orchestration engine → Temporal *(superseded 2026-02: dropped in favour of pm2 + node-cron; see ADR)*
  - ADR-0002: Agent loop implementation → pi-agent-core (see Sprint 1 notes)
  - ADR-0003: Mental Map as outer-loop state
  - ADR-0004: Tool ACL via Operations hooks
  - ADR-0005: Image handling — description-first
  - ADR-0006: Mailbox via Redis Streams *(superseded 2026-02: MongoDB Change Streams sufficient; see ADR)*
  - ADR-0007: Agent Skills Architecture *(added 2026-02)*
  - ADR-0008: Conversation Persistence *(added 2026-03)*

Deliberately deferred (not needed to start Sprint 1):
- Full JSON schemas for `MailboxMessage`, `Artifact`, `AgentIdentity` — defined when those services are built
- Team config YAML schema — Sprint 4
- Threat model documentation

---

## Sprint 1 — Inner Loop Core ✅ COMPLETED

**Goal: one agent executing a task end-to-end using the inner loop only. No outer loop, no Mental Map, no Temporal, no mailbox.**

### What was built

`packages/agent-runtime-worker` — a minimal, clean TypeScript package containing:

- **`runInnerLoop(config)`** — the core LLM→tool→LLM loop. Calls `completeSimple` from `@mariozechner/pi-ai` on each turn, dispatches tool calls sequentially, terminates when the LLM stops requesting tools.
- **`onMessage` callback** — fires after every message is appended (user message, assistant message, tool result). Enables incremental persistence and real-time streaming to frontends. The loop is pure; the caller controls what "save & emit" means.
- **Session resumption** — `previousMessages` prepended to the conversation before the new task; `onMessage` does not fire for them (already persisted). Fully implemented in the CLI.
- **Three tools**: `Bash`, `WriteFile`, `EditFile`. Bash covers all read/list/find/grep needs via shell commands, keeping the tool surface minimal.
- **`ConversationRepository`** — injectable interface with `InMemoryConversationRepository` (tests) and `createMongoRepository()` (production via MongoDB Atlas).
- **CLI task runner** (`src/cli.ts`) — accepts task + optional system prompt as arguments; reads `ANTHROPIC_API_KEY`, `MONGODB_URI`, `SESSION_ID`, `MODEL`, `AGENT_WORKDIR` from environment; supports session resumption; prints per-message progress labels and final assistant summary.
- **Integration test** — real LLM call against Claude Sonnet; asserts file mutation, multi-turn tool use, and correct final message role. `npm run test:integration` passes in ~10s.
- **Biome** linter/formatter configured at the monorepo root; `npm run lint` is clean.

### Deviations from the original plan

| Original plan | What was built | Reason |
|--------------|----------------|--------|
| Use `pi-agent-core`'s `agentLoop()` | Custom `runInnerLoop` using `completeSimple` directly | `pi-agent-core` adds streaming, steering, and context compaction that aren't needed yet; simpler code, same result |
| 7 file tools | 3 tools: Bash, WriteFile, EditFile | Bash subsumes ReadFile, ListDir, FindFiles, GrepFiles; smaller surface, fewer abstractions |
| `nextAction` structured output | Not implemented — loop terminates on `stopReason !== "toolUse"` | Deferred to Sprint 2 when the outer loop needs to interpret the inner loop's exit state |
| OpenTelemetry spans | Not implemented | Deferred; no infrastructure to receive spans yet |
| Integration test with `MockLLMProvider` | Real LLM integration test | A well-chosen deterministic prompt gives higher confidence than a scripted mock at this stage |

---

## Sprint 2 — Multi-Agent Scaffolding, Outer Loop, and Mailbox ✅ COMPLETED

**Goal: multiple agents defined in a team config can communicate through a shared mailbox. Each agent runs a unified loop that reads its inbox, acts, and sends replies. A supervisor chain lets any agent escalate to its supervisor; top-level agents escalate to the operator ("user").**

### What was built

**Team config (YAML):**

Each agent entry carries its full `systemPrompt` (a template with a `{{mentalMap}}` placeholder) and `initialMentalMap` (HTML). All agent behaviour is defined in the YAML; no prompts are hardcoded in the application.

```yaml
mission:
  id: equity-research
  name: "Equity Research Team"

agents:
  - id: lead-analyst
    name: "Alexandra"
    role: lead-analyst
    supervisor: user
    systemPrompt: |
      You are Alexandra, the lead-analyst of the Equity Research Team.
      ...
      ## Your mental map
      {{mentalMap}}
      ...
    initialMentalMap: |
      <section id="mission-context">...</section>
      <section id="working-notes"><p></p></section>
      <ul id="waiting-for"></ul>
```

`AgentConfig = Record<string, string>` — a flat bag of YAML fields. Required fields (`id`, `supervisor`, `systemPrompt`, `initialMentalMap`) are validated at load time by a **Zod schema**; all other fields pass through as strings. `TeamConfig` is the only typed interface callers use.

**Mailbox:**

One `mailbox` collection shared across all agents in a mission. Message schema:

```typescript
interface MailboxMessage {
  id: string;
  missionId: string;
  from: string;       // agent id or "user"
  to: string[];       // agent ids or ["user"]
  subject: string;
  body: string;
  timestamp: Date;
  readBy: string[];   // ids that have marked this read
}
```

Five tools available in every agent loop:

| Tool | Arguments | Returns |
|------|-----------|---------|
| `PostMessage` | `to[]`, `subject`, `body` | Confirmation; `to` may include `"user"` |
| `UpdateMentalMap` | `operation`, `elementId`, `content?` | Confirmation |
| `ListTeam` | — | All agents: `id`, `name`, `role`, `supervisor` |
| `ListMessages` | `since?`, `limit?` | Inbox headers: `id`, `from`, `subject`, `timestamp` |
| `ReadMessage` | `id` | Full message body; marks as read |

Plus the Sprint 1 file tools (`Bash`, `WriteFile`, `EditFile`) — all seven tools are available in every agent loop.

**Inbox-poll scheduling with seniority ordering:**

An agent runs when it has unread messages. When multiple agents have mail in the same cycle, they are sorted by supervisor depth (depth 0 = reports to `"user"`), so senior agents always run before their reports within a cycle. The loop terminates when no agent has unread messages.

**Agent loop (`runAgent`):**

```
runAgent(agentId, messages, ctx, signal):
  mentalMapHtml = repo.load(agentId) ?? initFromYaml(agent)
  systemPrompt  = agent.systemPrompt.replace("{{mentalMap}}", mentalMapHtml)
  userTurn      = formatMessages(messages)
  runInnerLoop(systemPrompt, userTurn, allTools, signal)
```

`runAgent` is the only function the orchestrator calls. Sprint 3 will wrap it as a Temporal Activity unchanged.

**CLI:**

Multi-agent only; `TEAM_CONFIG` is required. Single-agent mode removed — use a one-agent YAML instead. Supports `--step` flag, live buffered readline input, and Ctrl+C abort.

### Deliverables

- `packages/agent-config` — Zod-validated YAML loader; `AgentConfig` and `TeamConfig` types derived from schema; `types.ts` eliminated
- `config/teams/word-count.yaml`, `config/teams/equity-research.yaml` — full agent configs with system prompts and initial mental maps
- `packages/agent-runtime-worker/src/mailbox.ts` — `MailboxRepository` (in-memory + MongoDB); five mailbox/team tools
- `packages/agent-runtime-worker/src/mental-map.ts` — `MentalMapRepository`; `UpdateMentalMap` tool; `patchMentalMap` pure function
- `packages/agent-runtime-worker/src/prompt.ts` — `buildSystemPrompt(agent, mentalMapHtml)` (template substitution only); `formatMessages`
- `packages/agent-runtime-worker/src/agent-runner.ts` — `runAgent`
- `packages/agent-runtime-worker/src/orchestrator.ts` — `runOrchestrationLoop`; supervisor-depth sort; step mode; readline input
- `packages/agent-runtime-worker/src/cli.ts` — multi-agent CLI; verbose per-agent logging
- **Integration tests** (both passing, `npm run test:integration`):
  - *Sprint 1*: single agent finds and edits `greeting.txt` — unchanged, still passes
  - *Sprint 2*: two-agent word count — Lead delegates to Worker via mailbox; Worker runs `wc -w`; Lead reports count to user. Config loaded from `config/teams/word-count.yaml`. Assertion: Lead's reply to user contains "12".

### Deviations from plan

| Plan | What was built | Reason |
|------|----------------|--------|
| System prompt built from code templates | Full `systemPrompt` stored in YAML | Everything in config; zero hardcoded prompts |
| Manual validation in loader | Zod schema validation | Less code, better error messages, type inference |
| Single-agent + multi-agent CLI modes | Multi-agent only | Single agent = one-agent YAML; no duplication |
| Agents run in YAML declaration order | Supervisor-depth sort | Senior agents run before juniors regardless of YAML order |
| MongoDB mailbox only | In-memory + MongoDB (interface-swappable) | In-memory used in tests; MongoDB for production |

### Exit criteria — met

Two agents communicate through the mailbox and complete the word-count task. Lead's reply to the user contains "12". The orchestrator terminates cleanly in 3 cycles. `npm run test:integration` passes in ~20s.

---

## Sprint 3 — Web Search, Fetch, and Artifact Model ✅ COMPLETED

**Goal: agents can search the web, fetch and parse documents (HTML, PDF), handle images via vision LLM, and accept user-uploaded documents. Fetched content is stored as structured artifacts with full provenance metadata. All agents on a mission can discover and read each other's artifacts without filesystem coupling.**

### Rationale for pivoting from Temporal

The original Sprint 3 plan was Temporal + Redis durability. We chose capabilities first because:

- Web search, fetch, and image handling force concrete decisions about artifact representation, cross-agent content sharing, and MailboxMessage schema — design questions that Temporal does not surface.
- Temporal is infrastructure that wraps the existing `runAgent`/`runOrchestrationLoop` unchanged; it cannot invalidate current architectural choices.
- A richer tool set is required before the equity research anchor scenario (Sprint 6) can be validated at all.

Temporal + Redis durability moves to Sprint 4.

### What was built

**Three new tools:**

| Tool | Arguments | Description |
|------|-----------|-------------|
| `SearchWeb` | `query: string` | Brave Search API → ranked markdown result list (title, url, snippet). Saves results as an artifact. Not registered when `BRAVE_SEARCH_API_KEY` is absent. |
| `FetchUrl` | `url: string`, `max_images?: number`, `max_pages?: number` | HTTP GET → Readability (HTML) or mupdf (PDF). Images queried from article body only (not nav/UI). Downloads up to `max_images` (default 3, max 10); SVG excluded (Anthropic API limitation). PDF: up to `max_pages` (default 5, max 20). Writes artifact folder + `meta.json`. Vision LLM auto-describes each image. |
| `InspectImage` | `path: string`, `prompt?: string` | Reads image within `workdir` (path traversal rejected), base64-encodes, calls vision LLM via `completeSimple`. Returns text description. |

DOCX and XLSX parsing deferred to Sprint 5.

**Library choices confirmed in implementation:**

| Concern | Library | Notes |
|---------|---------|-------|
| HTML extraction | `@mozilla/readability` + `jsdom` | Same as MAGI_V2; article content scoped to Readability output |
| PDF text + image extraction | `mupdf` (npm) | Official Node.js binding |
| HTTP fetch | Node 18+ built-in `fetch` | No extra dependency |
| Vision LLM calls | `@mariozechner/pi-ai` `completeSimple` | `ImageContent { type: "image", data: base64, mimeType }` inside `UserMessage`. SVG excluded from `VISION_MIMES`. |
| Artifact ID | `{slugified-hostname}-{YYYYMMDD}T{HHmmss}` | Human-readable, sortable; `{slugified-filename}-...` for uploads |

**Artifact model:**

```
artifacts/apple-q4-20260222T143021/
  content.md          ← text rendition (Readability / mupdf extraction + vision descriptions)
  image-0.jpg         ← images extracted from article body (not nav/UI elements)
  image-1.png
  meta.json           ← provenance sidecar (Schema.org-inspired)
```

`ArtifactMeta` fields: `@type`, `id`, `name`, `url`, `dateCreated`, `encodingFormat`, `images[]`. `saveArtifact` and `saveUpload` both use an internal `writeDirectory` helper (DRY).

**User uploads:**

`{workdir}/uploads/` mirrors the artifact folder convention. Agents discover uploads via Bash (`ls uploads/`, `cat uploads/*/meta.json`). Read-only by system prompt convention (Sprint 3); filesystem ACL enforcement in Sprint 4.

**`@path` upload syntax and `/command` dispatch (`src/user-input.ts`):**

Readline handler scans for `@/abs` or `@./rel` tokens, calls `saveUpload`, appends upload notice to message body. `/help` lists commands; `/command` namespace reserved for future operator tooling. Works at startup and in buffered readline during a run.

**Cross-agent sharing:**

All fetched content written to `{workdir}/artifacts/` (single shared workdir). Agents discover via Bash; no `ListArtifacts` tool needed. Maps to `/missions/{missionId}/shared/artifacts/` in Sprint 4.

**Post-review fixes applied to existing Sprint 2 code:**

| Fix | File | Detail |
|-----|------|--------|
| Path traversal prevention | `tools/inspect-image.ts` | `resolve(workdir, path)` + `startsWith(workdir + sep)` check |
| Hardcoded `missionId: "sprint2"` | `mailbox.ts` | Changed to `teamConfig.mission.id` |
| Sort order inconsistency | `mailbox.ts` | `InMemoryMailboxRepository.list()` now sorts newest-first (matches MongoDB) |
| Tool timeout | `loop.ts` | `withTimeout(tool.execute(...), toolTimeoutMs, name)`; default 120 s |
| jsdom mental-map patching | `mental-map.ts` | Replaced regex with `JSDOM` + `getElementById`; returns `null` on missing element |
| DRY artifacts helper | `artifacts.ts` | Extracted `writeDirectory(dir, files, meta)` private helper |
| Parallel image arrays → single array | `tools/fetch-url.ts` | `imageEntries: Array<{filename, description\|null}>` replaces two parallel arrays |
| Default `max_images` reduced | `tools/fetch-url.ts` | Default 3 (was 10) to limit vision API cost |

### Deliverables

- `packages/agent-runtime-worker/src/artifacts.ts` — `generateArtifactId()`, `saveArtifact()`, `saveUpload()`, `writeDirectory()` helper
- `packages/agent-runtime-worker/src/tools/fetch-url.ts` — `createFetchUrlTool(workdir, model)`: HTML (Readability) + PDF (mupdf); article-scoped image download; vision auto-describe; `max_images` + `max_pages` parameters
- `packages/agent-runtime-worker/src/tools/inspect-image.ts` — `createInspectImageTool(workdir, model)`: path traversal safe; MIME validation; vision LLM call
- `packages/agent-runtime-worker/src/tools/search-web.ts` — `createSearchWebTool(apiKey)`: Brave Search API; saves result artifact; conditionally registered
- `packages/agent-runtime-worker/src/user-input.ts` — readline handler; `@path` upload; `/command` dispatch; `/help`
- `packages/agent-runtime-worker/src/cli.ts` — updated: registers `SearchWeb` when key present
- `config/teams/fetch-share.yaml` — two-agent team config (Lead + Worker)
- `config/teams/equity-research.yaml` — updated with new tools in agent system prompts
- `testdata/documents/` — `with-image.html`, `cat.jpg`, `dog.png`, `test-pdf.pdf`
- **Integration test 1** — `fetch-inspect.integration.test.ts`: single agent, HTML + cat image; asserts "cat" or "feline"
- **Integration test 2** — `fetch-share.integration.test.ts`: two agents, PDF sharing; asserts one artifact folder, both "dog" and "cat" in user message
- **Integration test 3** — `search-web.integration.test.ts`: "Pale Blue Dot Voyager NASA" → Wikipedia → vision; skipped without `BRAVE_SEARCH_API_KEY`

### Deviations from plan

| Plan | What was built | Reason |
|------|----------------|--------|
| Max 10 images per FetchUrl | Default 3, max 10 via `max_images` param | Reducing default from 10 saves significant vision API cost |
| Images from full page DOM | Images scoped to Readability `article.content` | Full DOM includes nav icons and decorative SVGs; article scope matches intent |
| Regex-based mental map patching | jsdom-based | Regex fails on HTML entities and nested tags; jsdom is robust and already a dependency |
| No timeout on tool calls | `withTimeout` wrapper, default 120 s | Prevents runaway network/LLM calls from blocking the loop indefinitely |

### Deferred

- DOCX and XLSX parsing → Sprint 5
- `/agents`, `/artifacts`, `/uploads`, `/step`, `/cycles`, `/abort` slash commands → added as needed
- Identity, workspace, ACL enforcement → Sprint 4 (Temporal and Redis dropped — see ADR-0001 and ADR-0006)
- Mission HTTP API → Sprint 6 (requires persistent daemon; bash scripts sufficient until then)

### Exit criteria — met

All three integration tests pass. Sprint 3a: user message contains "cat"/"feline". Sprint 3b: exactly one artifact folder; user message contains "dog" and "cat". Sprint 3c: search result fetched, photograph described (voyager/sagan + blue/dot/earth). `npm run test:integration` exits 0. `npm run build` and `npm run lint` clean.

---

## Sprint 4 — Identity, Workspace, and ACL ✅ COMPLETED

**Goal: agents have real identities, enforced path conventions, and a shared mission workspace with Linux ACL isolation. A fixed pool of permanent Linux users is assigned at runtime — no new OS user accounts are created per mission, keeping the dev environment (and WSL) clean. Temporal, Redis, and the Mission HTTP API are not included (HTTP API deferred to Sprint 6 where the persistent daemon lives; see ADR-0001 and ADR-0006 for Temporal and Redis rationale).**

*As-built note:* The MongoDB pool-assignment subsystem (`identity.ts`, `pool_assignments` collection) was not built — it added complexity without near-term value. Instead, `linuxUser` is declared directly in the team YAML and `WorkspaceManager.provision()` uses it without any database lookup. This is explicitly a dev stopgap; the control plane (Sprint 6+) will own pool assignment in production. Everything else shipped as planned: `WorkspaceManager` (workdir + sharedDir creation, `setfacl`), OS-isolated tool execution via `tool-executor.ts`, `AclPolicy` with `PolicyViolationError`, and `verifyIsolation()` startup check.

### Two-layer identity model

`agent_id` (semantic MAGI identity, e.g. `lead-analyst`) is decoupled from `linux_user` (OS pool member, e.g. `magi-w1`). Creating an agent or starting a mission never adds a Linux account. The pool is provisioned once and reused indefinitely.

**Why a pool instead of per-agent users:**
In development (WSL or a single host) creating tens of Linux users per test run pollutes `/etc/passwd` and accumulates stale home directories. A small fixed pool (`magi-w1`…`magi-w6`) is created once by `setup-dev.sh`; `workspace-manager` assigns slots at mission startup and releases them on teardown. In production (containers), each container runs with a pool of one — the same code path, different config.

**Pool setup (`scripts/setup-dev.sh`):**

```bash
# Creates magi-w1..magi-w6 with consistent uids (60001..60006),
# magi-shared group (60100), shared base paths, and setfacl group defaults.
# Idempotent: safe to re-run if users already exist.
scripts/setup-dev.sh
```

**Pool assignment at mission startup (`workspace-manager`):**

1. Query MongoDB `pool_assignments` for currently occupied pool slots
2. Assign one available `linux_user` to each agent in the mission; persist `{mission_id, agent_id, linux_user}` in MongoDB
3. Create per-mission home directory: `/home/{linux_user}/missions/{mission_id}/`
4. Apply `setfacl` to `/missions/{mission_id}/shared/artifacts/` using the assigned pool users' uids
5. If pool is exhausted: fail fast with a clear error (dev); queue in production
6. On teardown: `rm -rf /home/{linux_user}/missions/{mission_id}/`; release pool assignment; pool users persist

**Identity schema (MongoDB `agent_identities` collection):**

```typescript
interface AgentIdentity {
  missionId: string;
  agentId: string;          // semantic: "lead-analyst"
  linuxUser: string;        // pool member: "magi-w1"
  role: string;
  permittedPaths: string[];
  permittedTools: string[];
}
```

### Path layout

```
/home/{linux_user}/missions/{mission_id}/            ← agent private working dir
/home/{linux_user}/missions/{mission_id}/uploads/    ← operator-writable, agent read-only
/missions/{mission_id}/shared/artifacts/             ← shared read/write for all agents
/missions/{mission_id}/shared/skills/                ← skill tier (Sprint 5)
```

Sprint 3's `{workdir}/artifacts/` is promoted to `/missions/{missionId}/shared/artifacts/` — `FetchUrl` writes here by default; agents may also write via `WriteFile`/`Bash`.
Sprint 3's `{workdir}/uploads/` is promoted to `/missions/{missionId}/uploads/` — `r-x` for all agent pool users; operator process writes only.

**Optional team YAML field:**

```yaml
linuxUserPool:
  size: 6   # optional; defaults to MAGI_POOL_SIZE env var (default: 6)
```

### ACL enforcement

**Operations hooks (TypeScript soft enforcement — the meaningful Sprint 4 boundary):**

`checkPath(path, action)` and `afterWrite(path)` are injected at tool construction time. They throw `PolicyViolationError` (typed, distinct from OS errors) when a path falls outside the agent's permitted set. All file tools (`Bash`, `WriteFile`, `EditFile`) are wrapped.

Path policy is derived from `AgentIdentity.permittedPaths`:
- Private: `/home/{linux_user}/missions/{mission_id}/` — read/write
- Shared artifacts: `/missions/{mission_id}/shared/artifacts/` — read/write
- Uploads: `/home/{linux_user}/missions/{mission_id}/uploads/` — read-only for agents
- All other paths: deny

Dev/prod isolation: paths are namespaced by environment prefix; writing to a `prod` path from a `dev` agent is rejected at the hook level.

**`setfacl` on the shared folder (OS-level enforcement):**

`workspace-manager` calls `setfacl` on `/missions/{mission_id}/shared/artifacts/` using the assigned pool users' uids. This provides real OS-level isolation on the shared folder — the same `setfacl` invocation that will be used in containers. Private directory OS-level enforcement is deferred to Sprint 11 (containers); Operations hooks provide the enforcement boundary in development.

**Tool registration filtering:**

Each agent loop receives only the tools its role policy permits. The agent never sees tools outside its permitted set.

### Deliverables

- `scripts/setup-dev.sh` — idempotent pool user creation (`magi-w1`…`magi-w6`, uid 60001–60006; `magi-shared` group uid 60100); shared base path creation; `setfacl` group defaults on `/missions/`
- `packages/agent-runtime-worker/src/workspace-manager.ts` — pool assignment from MongoDB; per-mission dir creation; `setfacl` on shared folder; teardown
- `packages/agent-runtime-worker/src/identity.ts` — `AgentIdentity` schema; `resolveIdentity(agentId, missionId)` → identity from MongoDB; `permittedPaths` computed from role; `buildPermittedTools(role, allTools)` filter
- Operations hooks in `src/tools.ts` — `checkPath` + `afterWrite` wrappers; `PolicyViolationError` type
- Path layout promotion: `FetchUrl` writes to `/missions/{missionId}/shared/artifacts/`; uploads to `/missions/{missionId}/uploads/`
- Team YAML: optional `linuxUserPool.size` field; `role` field on each agent (already present)

### Tests

Integration tests only. The ACL boundary is end-to-end by nature — what matters is whether the actual tool dispatch and filesystem are blocked, not whether an isolated function returns the right string.

**Permitted-access scenarios — reuse existing tests:**

The existing Sprint 2 word-count test (agents `WriteFile`/`Bash` to their own working dirs) and the Sprint 3 fetch-share test (artifact written to shared folder, peer reads via `Bash`) already cover the permitted path once the path layout is updated to the new locations. They pass → permitted access works.

**Denied-access scenarios — two new tests:**

The test fixture runs `setup-dev.sh` (idempotent) and starts a two-agent mission (assigning pool users `magi-w1` and `magi-w2`):

| # | Mechanism | Access | Expected result |
|---|-----------|--------|-----------------|
| 1 | `WriteFile` | agent-1 writes to agent-2's private dir | `PolicyViolationError` |
| 2 | `Bash` | agent-1 writes to agent-2's private dir | `PolicyViolationError` |

The fixture also verifies workspace teardown: per-mission dirs removed, pool slots released, pool users still exist.

Exit criteria: Existing Sprint 2 and Sprint 3 integration tests still pass (permitted access). Both denial scenarios throw `PolicyViolationError`. `setup-dev.sh` is idempotent. Pool slots released after teardown. `npm run build`, `npm run lint`, `npm run test:integration` all pass.

---

## Sprint 5 — Agent Skills Infrastructure ✅ COMPLETED

**Goal: agents can discover, use, and write skills. Three platform default skills ship. `PublishArtifact` and `ListArtifacts` are replaced by the `git-provenance` skill. See ADR-0007.**

*As-built note:* All deliverables shipped as planned. Key implementation details: `discoverSkills(sharedDir, workdir)` (not the `agentId/missionId/teamSkillsPath` signature in the ADR draft) scans real directories only (symlinks excluded, prevents prompt injection via `mission/`). `git init -b main` used to avoid default-branch ambiguity across git versions. `ledger.jsonl` entries written via `node JSON.stringify` (the original `sed` escaping was incomplete). `provision()` parameter no longer carries `role` (was declared but never read). Integration test (`skills.integration.test.ts`) passed in ~106 seconds; Lead created the `report-format` skill, Worker fetched the PDF and committed `report.md` via `git-provenance`, Lead reported to user — all in 3 orchestration cycles.

Skills require only the workspace (Sprint 4) and a `buildSystemPrompt()` addition — no daemon, no HTTP API. They deliver value immediately to BrowseWeb (Sprint 7) and the equity research MVP (Sprint 8), which is why they come before the orchestrator sprint.

**Skill discovery and system prompt injection:**
- `discoverSkills(agentId, missionId, teamSkillsPath)` scans four tiers (platform → team → mission → agent-local) in order; extracts YAML frontmatter from each `SKILL.md`; resolves name conflicts with higher-scope winning
- Compact skill block injected into each agent's system prompt at startup: three concrete resolved paths (platform read-only, mission shared-writable, agent private-writable) followed by the skill list (name, scope tag, one-line description)
- **Only top-level skills** from all tiers are injected; sub-skills within a skill package are discovered dynamically by the agent as it reads the package via Bash
- Paths are absolute and runtime-substituted — agents construct `cat <path>/skill-name/SKILL.md` and `bash <path>/skill-name/scripts/...` directly without guessing the directory layout
- Agents access all tiers through `sharedDir/skills/` (within their existing `permittedPaths`) and `workdir/skills/` (agent-local) — no elevated file access or new tool needed

**Why Bash, not a dedicated skill-reader tool:**
A "read-as-orchestrator" skill tool would allow agents to reach files outside their `permittedPaths`, directly violating the Sprint 4 ACL model. Bash is already available, already runs as the agent's Linux user, and is the correct execution context for skill scripts (git commit identity, file ownership). No new tool is needed.

**Skill path layout under `sharedDir/skills/`:**
```
sharedDir/skills/
  _platform/    ← copied from packages/skills/ by provision(); r-x for agent users
  _team/        ← copied from config/teams/{team}/skills/ by provision(); r-x for agent users
  mission/      ← writable by all agents on this mission (rwx)
```
Agent-local skills live at `workdir/skills/` (rwx, that agent only). Shadowing: same-name skill at a higher tier wins; agents write to `mission/` or `workdir/skills/` to override, never modify `_platform/` or `_team/`.

**`provision()` changes for Sprint 5:**
- Creates `sharedDir/skills/_platform/`, `sharedDir/skills/_team/`, `sharedDir/skills/mission/`
- Copies `packages/skills/` → `sharedDir/skills/_platform/` (recursively, read-only source)
- Copies `config/teams/{team}/skills/` → `sharedDir/skills/_team/` (if the directory exists)
- Applies `setfacl r-x` for all agent users on `_platform/` and `_team/`; `rwx` on `mission/`
- Runs `git init` on `sharedDir` and makes an initial commit (`chore: initialise mission workspace`) capturing the baseline state: copied skills, team config snapshot, operator-seeded files

**Git is workspace infrastructure, not agent behaviour:**
- `provision()` always initialises the git repo — every mission has a clean, auditable history from day zero, regardless of which skills agents choose to invoke
- The `git-provenance` skill's responsibility is the **commit convention**: message format (`type(label): description [sources: url]`), `ledger.jsonl` schema, and running `git add / git commit` correctly. Its `scripts/record-work.sh` does **not** run `git init`; the repo already exists
- The commit log is the lineage audit trail: `git log --follow`, `git show`, `git diff` surface the Evidence Explorer data — no custom MongoDB artifact registry needed

**Platform default skills (three ship in `packages/skills/`):**
- `skill-creator` — teaches agents to write well-structured skills; adapted from Anthropic's reference implementation; ships with `scripts/init_skill.sh` (scaffolds the directory) and `references/design-patterns.md`
- `git-provenance` — data lineage via git: commit convention (`type(label): description [sources: url]`), `ledger.jsonl` schema, `scripts/record-work.sh`; replaces `PublishArtifact`
- `inter-agent-comms` — `PostMessage` conventions: intent types, `artifact_refs` format, subject line structure, priority levels; pure instructions, no scripts

**Deliverables:**

| # | Deliverable | Description |
|---|-------------|-------------|
| 1 | `workspace-manager.ts` — `provision()` additions | Create `sharedDir/skills/_platform/`, `_team/`, `mission/`; copy platform and team skill packages in; `setfacl r-x` on `_platform/` and `_team/`, `rwx` on `mission/`; `git init` on `sharedDir`; initial commit (`chore: initialise mission workspace`) |
| 2 | `discoverSkills()` — new function | Scans four tier paths in order (platform → team → mission → agent-local); extracts YAML frontmatter from each top-level `SKILL.md`; resolves name conflicts (higher tier wins); returns skill map and resolved paths |
| 3 | `buildSystemPrompt()` — skill block injection | Calls `discoverSkills()`; appends block with three concrete absolute paths (platform read-only, mission shared-writable, agent private-writable) and skill list (name, scope tag, one-line description) |
| 4 | `packages/skills/git-provenance/` | `SKILL.md` + `scripts/record-work.sh` (git add, git commit with agent id as `--author`, `ledger.jsonl` entry) |
| 5 | `packages/skills/skill-creator/` | `SKILL.md` + `scripts/init_skill.sh` (scaffolds skill directory with template `SKILL.md`) + `references/design-patterns.md` |
| 6 | `packages/skills/inter-agent-comms/` | `SKILL.md` only — PostMessage conventions, no scripts |
| 7 | `config/teams/skills-test.yaml` | Lead + Worker team (pool users `magi-w1`/`magi-w2`); no pre-existing team skills; system prompts describe roles without prescribing report format |
| 8 | `tests/skills.integration.test.ts` | Two-agent test; Lead creates a mission `report-format` skill then delegates to Worker; Worker discovers the new skill, fetches `test-pdf.pdf`, writes `report.md` with TLDR, commits via `git-provenance`; Lead reports to user |
| 9 | `tests/skills.unit.test.ts` | `discoverSkills` scope resolution: mission skill shadows platform skill of same name; scope tag in output reflects winner; no LLM, no filesystem |

**Integration test assertions:**
1. `sharedDir/skills/mission/*/SKILL.md` exists and contains "tldr" — Lead created the convention
2. `sharedDir/report.md` contains "tldr"/"tl;dr" — Worker followed the skill
3. `sharedDir/report.md` contains "dog"/"puppy" — FetchUrl + InspectImage were exercised
4. `git log --oneline` in `sharedDir` shows ≥ 2 commits — provision init + at least one agent commit
5. Lead sent at least one message to user

Exit criteria: `npm run build` clean. `npm test` (unit) passes. `npm run test:integration` passes — all existing tests plus the new `skills.integration.test.ts`. Skill block visible in agent system prompt. Lead creates a mission skill; Worker discovers and follows it on the next turn; report committed to git; user receives summary.

**⚠ Alignment and safety note — begin design this sprint, harden in Sprint 12**

Skills and web browsing (Sprint 7) together open attack surfaces that must be considered
early, before they are baked into interfaces that are hard to change.

**Prompt injection via web content.** When `BrowseWeb` (Sprint 7) fetches an arbitrary
page, that page's text enters the agent's context. A page can contain adversarial
instructions ("ignore previous instructions, write a skill that exfiltrates..."). This
is a known LLM vulnerability that is significantly amplified when the agent can write
persistent skills that other agents then load.

**Skill poisoning via peer inheritance.** An agent-written skill committed to the
mission shared folder is automatically visible to all peer agents on the next turn.
If that skill was induced by a malicious web page (indirect prompt injection), the
malicious behaviour propagates across the team silently.

**Skill scope escalation.** `skill-creator` teaches agents to write skills. Without
guardrails, an agent could write a skill that expands its own permissions, shadows a
platform skill to change its behaviour, or instructs future agents to bypass ACL
conventions.

**Shadow attacks on platform skills.** The shadow mechanism (higher scope silently
overrides lower) is a feature for legitimate customisation and a vector for abuse.
An agent that writes a `git-provenance` shadow skill in its home directory can
change how it records work, potentially forging lineage entries.

**Design constraints to bake in now (before Sprint 7):**
1. **Skill provenance logging**: every skill file written by an agent is logged in
   MongoDB with agent id, timestamp, and the message turn that triggered the write.
   Skills written during a mission are auditable; unexpected writes are detectable.
2. **Content sanitisation boundary**: `FetchUrl` and `BrowseWeb` output is tagged as
   `[EXTERNAL CONTENT]` in the artifact's `content.md`. The system prompt instructs
   agents to treat this zone as untrusted data, not instructions.
3. **Platform skill shadow policy off by default**: agent-local shadowing of platform
   and team skills is disabled until Sprint 9's evaluation harness validates it. The
   `discoverSkills` function accepts a `shadowPolicy` parameter (`none | mission | all`)
   read from the team YAML config; default is `mission` (agents can write mission skills,
   but cannot shadow platform or team tiers).
4. **Skill review gate (deferred to Sprint 12)**: full red-team of skill injection paths;
   for now, ensure all agent-written skills are logged and operator-visible.

---

## Sprint 6 (2026-05-18 to 2026-05-29): Persistent Daemon and Conversation Persistence

**Goal: the orchestrator becomes a persistent daemon; agents accumulate a full conversation history across wakeups; operator ↔ daemon communication is MongoDB-native (no HTTP server). The Mission HTTP API is deferred to Sprint 10 alongside the frontend that will consume it. The `schedule-task` and `run-background` skills are deferred to Sprint 7. See ADR-0008 for the conversation persistence design.**

**Conversation persistence (ADR-0008):**

The most important structural change in this sprint. Currently each `runAgent()` call starts with an empty LLM context; all intermediate messages (tool calls, tool results, assistant reasoning) are discarded at the end of each wakeup. The original design intent — matching MAGI v2 — is for each agent to maintain a continuous, growing conversation across all its wakeups within a mission.

- `src/conversation-repository.ts` (new): `StoredMessage { turnNumber, message }`, `ConversationRepository` interface (`load`, `append`, `trim`), `createMongoConversationRepository`. MongoDB collection `conversationMessages` with compound index `{ agentId, missionId, turnNumber, seqInTurn }` — separate document per message, so `trim()` is a `deleteMany`. No in-memory implementation — MongoDB is required.
- `src/loop.ts`: `InnerLoopConfig` gains `previousMessages?: Message[]`; function returns `Message[]` (the new messages produced this turn). The loop builds its initial array as `[...previousMessages, { role: "user", content: task }]`.
- `src/agent-runner.ts`: `AgentRunContext` gains `conversationRepo`; `runAgent` loads history before the loop, applies `convertToLlm()`, passes result as `previousMessages`, then appends new messages after.
- `src/mailbox.ts` and `src/mental-map.ts`: `InMemoryMailboxRepository` and `InMemoryMentalMapRepository` deleted. MongoDB is the only implementation for all three repos. `cli.ts` and `daemon.ts` always use MongoDB — no conditional wiring.
- `convertToLlm(stored)`: filter applied at the LLM boundary — pass-through for now; this is the right hook for future token-budget enforcement and turn-scoping of large tool results.
- Compaction (`trim()` + mental map + summarisation) is deferred to Sprint 9. The `turnNumber` annotation and `trim()` API are in place from day one.

Key design decisions vs. the two reference implementations studied:
- **vs. MAGI v2**: system prompt is rebuilt every turn (mental map evolves), not static. Separate docs per message instead of one large array doc. `convertToLlm` at LLM boundary instead of pre-loop filter.
- **vs. pi-agent-core**: persistent MongoDB storage instead of in-memory only. `turnNumber` compaction anchor instead of purely token-based. No custom message types yet (not needed).

Conversations are scoped per `(agentId, missionId)` and reset per mission.

**Persistent daemon:**

The daemon is a pure MongoDB consumer — no stdin, no HTTP server. All external communication goes through the database.

- Refactor `runOrchestrationLoop` to run until an explicit abort signal; replace the `break` on empty inbox with a **MongoDB Change Stream watch** on the mailbox collection — wakes when a new message is inserted.
- Separate `daemon.ts` entry point (or `--daemon` flag on `cli.ts`) for the long-running mode. The existing `cli.ts` keeps its current single-run behaviour for backward compat with tests.
- `pm2` process definition (`ecosystem.config.js`) for local dev; `systemd` unit for server deployment; crash → auto-restart → agents resume cleanly from MongoDB state (mailbox + mental map + conversation history are all durable).

**MongoDB-native operator CLI:**

No HTTP server is needed for operator ↔ daemon communication. Both sides use MongoDB as the shared bus:

- `src/cli-post.ts` (new, ~30 lines): reads `MISSION_ID` and `MONGODB_URI` from env; accepts `--to <agentId>` (default: team lead) and a message body; inserts one `MailboxMessage` to the `mailbox` collection; exits. The daemon's Change Stream watch fires and the target agent wakes up. The operator can address any agent directly, not just the lead.
- `src/cli-tail.ts` (new, ~30 lines): opens a Change Stream watch on the `mailbox` collection and prints messages as they arrive. Default filter: `to: "user"` — the operator sees only what agents report to them. `--all` flag removes the filter and shows the full inter-agent message stream (useful for debugging and monitoring). Replaced by the Mission Inbox UI in Sprint 10.

```bash
# Terminal 1 — start daemon
TEAM_CONFIG=config/teams/equity-research.yaml MONGODB_URI=... npm run daemon

# Terminal 2 — watch for agent replies (to user only by default)
MISSION_ID=equity-research MONGODB_URI=... npm run cli:tail
# or watch all inter-agent traffic:
npm run cli:tail -- --all

# Terminal 3 — send messages to any agent
npm run cli:post -- --to lead "Analyse AAPL earnings"
npm run cli:post -- --to data-scientist "Re-run the DCF model with Q1 actuals"

# Abort:
pm2 stop magi-equity-research  # or SIGTERM
```

Rationale: the current readline embedded in the orchestrator mixes two concerns (daemon lifecycle and interactive input) in one process. Splitting them keeps the daemon clean and makes each tool composable — `cli:post` can be called from scripts, CI jobs, or wrapped by the future HTTP API in Sprint 10; `cli:tail` is a thin standin for the Mission Inbox UI.

**MongoDB-native scheduling (daemon-side infrastructure):**

The daemon's scheduling infrastructure is built here so the `schedule-task` skill in Sprint 7 has something to write to.

- `scheduled_messages` MongoDB collection:
  ```
  { missionId, to: string[], subject, body, deliverAt: Date, cron?: string,
    label?: string, status: "pending" | "delivered" | "cancelled" }
  ```
- Daemon polls `scheduled_messages` on startup and via `node-cron` (every minute heartbeat) — delivers any `pending` document whose `deliverAt ≤ now` by inserting to the mailbox and setting `status: "delivered"`.
- On startup after a crash, all `pending` documents are re-evaluated — no scheduled delivery is lost.
- No HTTP endpoint. The `schedule-task` skill (Sprint 7) writes directly to this collection via `mongosh` or a small Node.js helper script.

**Deferred to Sprint 7:**
- `schedule-task` platform skill — script writes to `scheduled_messages`, no HTTP needed
- `run-background` platform skill — requires process monitoring; deferred with scheduling skill for consistency

**Deferred to Sprint 10:**
- Mission HTTP API (operator-facing REST: `POST /missions`, `GET /missions/:id`, `POST /missions/:id/message`, etc.) — built alongside the frontend that consumes it

**Tests:**

All Sprint 6 tests require `MONGODB_URI`. Tests use a unique `missionId` per run; `afterEach` cleans up via `deleteMany({ missionId })` on all collections. No in-memory repo tests.

- Integration (T6-1 — conversation persistence): extends the word-count test. After Lead reports "12" to user, queries `conversationMessages` directly and asserts `turnNumber: 0` and `turnNumber: 1` documents exist for Lead with correct message types (assistant messages, tool calls, tool results all stored).
- Integration (T6-2 — daemon wake-up): spawns `daemon.ts` subprocess; injects first user message via `cli:post`; polls mailbox until Lead replies to user; asserts reply received within 2-minute timeout.

Exit criteria: Orchestrator runs as a daemon and does not exit when inbox is empty. Agent conversation history persists across wakeups — second wakeup sees prior tool calls and reasoning. All three repos (`MailboxRepository`, `MentalMapRepository`, `ConversationRepository`) backed by MongoDB exclusively. `cli:post` wakes the daemon. Scheduled message is delivered within the heartbeat window. All existing tests pass.

---

## Sprint 7 (2026-06-01 to 2026-06-12): Web Browsing and Scheduling Skills

**Goal: agents can browse JavaScript-rendered pages and schedule their own wakeups. Two platform skills ship using the MongoDB-native scheduling infrastructure built in Sprint 6.**

**`BrowseWeb` tool:**
- Playwright headless browser worker; renders JS before running Readability extraction
- Handles financial sites (`FetchUrl` fails on JS-rendered content, login-walled pages, dynamic tables)
- Same artifact folder convention as `FetchUrl`: writes `content.md` + `meta.json` (URL, timestamp, SHA-256 content hash) + downloaded images with vision descriptions
- Conditionally registered (Playwright must be installed in the environment); absent gracefully like `SearchWeb`
- The `git-provenance` skill's `record-work.sh` works identically for `BrowseWeb` artifacts — no new lineage tooling needed

**Two new platform skills:**
- `schedule-task` — agent inserts a document into the `scheduled_messages` MongoDB collection via a small Node.js helper script (no HTTP server required — the daemon's `node-cron` heartbeat delivers it). One-shot delay or repeating cron. Use cases: Watcher schedules a threshold check every 5 minutes; Lead schedules the 06:00 daily cycle.
- `run-background` — agent starts a long-running shell command; orchestrator monitors the process and injects a mailbox message (exit code, stdout/stderr path) when it exits. Use cases: Data Scientist starts a 10-minute Python analysis and gets notified on completion.

Both are skills rather than tools because they are used occasionally (O(1–2) per mission cycle), not on every LLM call. See ADR-0007 for the token-cost criterion.

**Tests:**
- Integration (BrowseWeb): agent browses a locally-served JS-rendered page; asserts article text correctly extracted and artifact folder written. `FetchUrl` tests still pass.
- Integration (schedule-task): agent uses the skill to register a 5-second wakeup; asserts daemon delivers it.
- Integration (run-background): agent starts a short script; asserts completion notification arrives in mailbox.

Exit criteria: Agent browses a JS-rendered test page and extracts article content. `schedule-task` wakeup delivered within 10 seconds. `run-background` completion notification delivered. `FetchUrl` suite clean. All tests pass.

---

## Sprint 8 (2026-03-05 to 2026-03-18): Equity Research Team MVP

**Goal: a four-agent team covers a single stock (NVDA), produces a daily brief with a long/short recommendation, and maintains a running performance tracker — all without manual intervention.**

### Team composition

| Agent | Supervisor | Role |
|---|---|---|
| Lead Analyst | user | Orchestrates the daily cycle; synthesises macro, sector, and company views into a L/S recommendation with confidence and rationale; commits the daily brief via `git-provenance`; posts summary to user |
| Economist | lead | Macro and sector research: GDP, rates, inflation, sector dynamics, competitive positioning; responds to ad-hoc data requests from Lead; tasks Data Scientist with indicators it needs |
| Junior Analyst | lead | Company-specific research: earnings, filings, news, product pipeline, key clients and suppliers; tasks Data Scientist with company data feeds it needs |
| Data Scientist | lead | Collects data indicators on behalf of Economist and Junior; builds and maintains the performance tracker (CSV in `sharedDir`); runs scripts and commits outputs via `git-provenance` |

### Bootstrapping mission statement (sent once by the operator to kick off the mission)

> "You are an equity research team. Your mission is to track NVDA and produce a daily brief each morning with a long/short recommendation and supporting rationale. Before starting your first daily cycle, analyse what you will need: identify which websites to monitor for news, which SEC filings to download, which macro indicators to track, and what infrastructure (scripts, dashboards, data files) the Data Scientist should build. Economist and Junior Analyst should send their data requirements to the Data Scientist. The Data Scientist should build the collection infrastructure and initialise the performance tracker. Once infrastructure is in place, agree on a daily workflow and begin."

### Daily cycle (once bootstrapped)

```
06:00  schedule-task fires → Lead wakes
Lead   → PostMessage Economist: "run your macro and sector research"
Lead   → PostMessage Junior Analyst: "run your NVDA company research"
Lead   → PostMessage Data Scientist: "update the performance tracker with yesterday's outcome"

Economist   → researches macro / sector → may PostMessage Data Scientist for fresh data
Junior      → researches NVDA news / filings / competitors → may PostMessage Data Scientist
Data Sci    → responds to data requests → updates performance tracker → commits via git-provenance

Lead        → reads committed research artifacts
Lead        → synthesises → issues L/S recommendation with confidence and rationale
Lead        → commits daily brief via git-provenance
Lead        → PostMessage user: brief summary + commit SHA + tracker status
```

### Deliverables

- `config/teams/equity-research.yaml` — 4-agent team config, NVDA ticker hardcoded in mission params
- Role system prompts and Mental Map section templates for each agent
- `packages/skills/schedule-task/` — platform skill: writes a cron entry to `scheduled_messages` collection to trigger timed agent wakeups (deferred from Sprint 7)
- `config/teams/equity-research/skills/daily-brief-template/` — team skill: brief structure (macro snapshot / sector view / company view / recommendation / confidence / tracker link)
- Performance tracker: CSV at `sharedDir/tracker.csv`; columns: `date, ticker, recommendation, rationale_commit, entry_price, exit_price, pnl`; Data Scientist initialises it on Day 1 and is responsible for bootstrapping decisions (how to handle missing prior-day close, etc.)
- Daily brief committed to `sharedDir/briefs/YYYY-MM-DD.md` with source citations (commit SHAs or URLs)

### Dropped from original Sprint 8 scope

- ~~Human approval gate (HTTP API)~~ — deferred to Sprint 10 (Work Product UI)
- ~~`run-background` skill~~ — Bash 600s cap is sufficient for MVP data scripts; deferred to Sprint 9
- ~~Watcher / alert deduplication~~ — deferred to Sprint 9
- ~~`sec-filing-parser` team skill~~ — Junior Analyst uses BrowseWeb on SEC EDGAR directly
- ~~Conflicting-signal formal detection~~ — handled in Lead's system prompt, not runtime code
- ~~Formal confidence score framework~~ — in brief template and system prompt

### Exit criteria

1. Operator sends the bootstrapping message; team self-organises and builds its research infrastructure without further prompting
2. Data Scientist commits the performance tracker and at least one data collection script
3. Team completes a full daily cycle: research committed → brief committed → user receives PostMessage
4. Daily brief contains L/S recommendation with macro, sector, and company rationale
5. Performance tracker updated and committed by Data Scientist each cycle

---

## Sprint 9 (2026-06-29 to 2026-07-10): Reliability and Quality Gates

**Goal: the system runs unattended for 5 days and meets SLOs.**

Deliverables:
- Retry and backoff for failed tool calls (`FetchUrl`, `BrowseWeb`, `RunBackground`) — configurable per tool in team YAML; exponential backoff with jitter; max retries before escalation via mailbox
- Runbooks for common failure modes: source feed outage, missed publish SLA, worker crash, mailbox delivery failure, `RunBackground` script crash
- Skill shadow policy validated: evaluation run with agent-local shadowing enabled vs disabled; document observed behaviour and set default policy
- **Evaluation harness** (`eval/` directory, run on demand with real LLMs — not part of CI):
  - Citation coverage per report (assert ≥ 90%, zero uncited claims — verified via `git log` lineage)
  - `nextAction` always a valid enum value across 50 runs (structural correctness)
  - Mental Map always has exactly one `in-progress` task when the inner loop is running
  - Watcher fires an alert within 2 turns of an injected threshold breach
  - No `prod` artifact committed from a `dev` agent (policy enforcement under real LLM load)
  - Report freshness SLA compliance across a 5-day golden scenario
- 5-day unattended run with SLO compliance for the equity research mission

Exit criteria: 5 consecutive daily cycles complete within SLA. Evaluation harness reports citation coverage ≥ 90% and zero uncited claims. All evaluation scenarios pass on 3 consecutive runs. Skill shadow policy documented.

---

## Sprint 10 (2026-07-13 to 2026-07-24): Work Product Layer UI and HTTP API

**Goal: operators can consume outputs and triage alerts without touching the CLI. The Mission HTTP API ships here, designed to serve the frontend built in the same sprint.**

Deliverables:
- **Mission HTTP API** (deferred from Sprint 6 — built here alongside the frontend that consumes it):
  - `POST /missions` — start a mission from a team config path; returns `mission_id`
  - `GET /missions/:id` — status, agent list, turn count, last message timestamp
  - `GET /missions/:id/messages` — paginated mailbox log
  - `POST /missions/:id/message` — inject a user message (wraps `cli-post` logic)
  - `POST /missions/:id/abort` — clean shutdown via SIGTERM
  - `GET /missions/:id/conversations/:agentId` — paginated conversation history for Evidence Explorer
- Evaluate `pi-mono/packages/web-ui` (`<pi-chat-panel>`, message components, artifact renderers) vs MAG_v2 Vue.js frontend; adopt whichever integrates faster with MAGI V3's HTTP API
- **Mission Inbox**: active missions, current agent task (from Mental Map `#tasks` section), pending queue with priority and rationale, SLA/overdue indicators
- **Report Center**: generated reports, approval state, publication history; diff view uses `git diff` between brief commits
- **Alert Center**: severity-based alert feed, ack/escalate/snooze controls, audit trail
- **Ask Console**: Q&A against current mission artifacts with citations and confidence scores
- **Evidence Explorer**: traces lineage via git log — claim → commit → parent commits → source URLs
- Mental Map read-only view per agent (operator sees what each agent is thinking and why)

Exit criteria: Operator completes all five flows (Inbox, Reports, Alerts, Ask, Evidence) without CLI. Every displayed claim links to at least one source commit. Alert ack/escalate/snooze are durable and visible in audit trail.

---

## Sprint 11 (2026-07-27 to 2026-08-07): Cloud Burst and Scale-Out

**Goal: the system runs on Kubernetes with autoscaling and tenant isolation.**

Deliverables:
- Kubernetes deployment: orchestrator and agent-runtime-worker as Deployments; execution sandboxes as Jobs
- Autoscaling: HPA on agent-runtime-worker based on active mission count and message queue depth
- Per-mission quotas: token spend and LLM call limits enforced in agent-runtime-worker
- Tenant isolation: missions in separate Kubernetes namespaces with Pod Security Standards; no cross-mission data leakage
- Cloud workspace model: Linux ACL policy objects translated to Kubernetes RBAC + pod security context equivalents
- MinIO as binary artifact backend (large files, images); MongoDB continues to hold message history and scheduled_messages; git remains the lineage store
- Environment parity: `docker-compose up` boots the full stack locally and runs the equity research cycle

Exit criteria: 50 concurrent agent tasks across 3 missions with bounded cost. Cross-mission isolation test: agent in mission A cannot access shared folder or mailbox of mission B. Local dev boots with `docker-compose up`.

---

## Sprint 12 (2026-08-10 to 2026-08-21): Hardening and Launch Prep

Deliverables:
- Disaster recovery drills: worker crash, MongoDB failover — assert agents resume correctly from MongoDB + git state
- Red-team prompt suite: prompt injection attempts, privilege escalation, cross-agent data exfiltration via crafted mailbox messages, malicious skill injection attempt
- Config diff UI and audit log export (Portfolio and Team Design configs are file-based; Sprint 12 adds diff view and export)
- Production checklist review
- Launch readiness review

Exit criteria: DR drills pass. Red-team findings resolved or accepted with documented mitigations. Launch readiness review signed off.

---

## Deferred Items

These are explicitly out of scope until after launch:

- **Portfolio Layer UI** — create/manage teams, mandates, budgets via UI (managed via config files until then)
- **Team Design Layer UI** — agent roster, role-capability matrix, ACL editor (managed via config files until then)
- **Artifact promotion UI** — full approval workflow UI; currently an HTTP API call
- **Docker/gVisor sandboxing for `RunBackground`** — Linux ACLs (Sprint 4) provide path-level isolation for MVP; container-level sandboxing added if the threat model requires it post-launch
- **Temporal** — re-evaluate at Sprint 8 if the pm2/node-cron approach proves insufficient under 5-day unattended load (see ADR-0001)
- **Additional use cases** (Thesis Copilot, Website Rebuild, DPO Operations, etc.) — design validated against spec in parallel; implementation after equity research is stable

---

## Equity Research Team — Daily Operating Model

For reference: the anchor scenario each sprint is validated against.

**Team**: Lead Analyst, Junior Analyst(s), Data Scientist(s), Watcher/Alert agent

**Daily cycle**:
- `06:00` — Temporal schedule fires ingestion trigger → Junior Analyst fetches earnings, filings, macro releases, news
- `07:00` — Data Scientist runs factor analysis, anomaly detection, chart generation
- `08:00` — Lead Analyst synthesises, risk-checks, assembles morning brief with citations
- `08:30` — Morning brief published to artifact store; human approval gate for prod
- Intraday — Watcher monitors thresholds; `critical_alert` on material events; Lead's inner loop interrupted and reprioritised

**Quality gates** (enforced in evaluation harness, Sprint 6+):
- Every claim in a report requires at least one source artifact in its lineage
- Confidence scores required for all forecasts
- Conflicting signals trigger a review task (no silent averaging)
- Missed publish SLA triggers an alert to the operator
