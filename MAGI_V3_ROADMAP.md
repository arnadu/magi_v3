# MAGI V3 Roadmap

## Objective

Build an autonomous multi-agent system that can write and run code, browse the web, process data, run agents in parallel, and let agents communicate and coordinate on shared missions.

Primary anchor scenario: an equity research team producing daily market briefs, weekly sector reports, and event-driven alerts with full citation lineage.

## Guiding Principle: Backend First

The UI is deferred until the backend is solid and delivering real value. The first five sprints produce a working, observable multi-agent backend with no frontend beyond raw API responses and log output. A minimal Work Product UI follows only once the core loop, orchestration, and multi-agent coordination are proven.

This ordering avoids building UI on top of a shifting foundation, and forces the architecture to be clean before it is wrapped.

---

## Sprint 0 — Architecture Freeze ✅ COMPLETED

Deliverables completed:
- Six Architecture Decision Records in `docs/adr/`:
  - ADR-0001: Orchestration engine → Temporal
  - ADR-0002: Agent loop implementation → pi-agent-core (see Sprint 1 notes)
  - ADR-0003: Mental Map as outer-loop state
  - ADR-0004: Tool ACL via Operations hooks
  - ADR-0005: Image handling — description-first
  - ADR-0006: Mailbox via Redis Streams

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

## Sprint 3 — Web Search, Fetch, and Artifact Model ← NEXT

**Goal: agents can search the web, fetch and parse documents (HTML, PDF), handle images via vision LLM, and accept user-uploaded documents. Fetched content is stored as structured artifacts with full provenance metadata. All agents on a mission can discover and read each other's artifacts without filesystem coupling.**

### Rationale for pivoting from Temporal

The original Sprint 3 plan was Temporal + Redis durability. We chose capabilities first because:

- Web search, fetch, and image handling force concrete decisions about artifact representation, cross-agent content sharing, and MailboxMessage schema — design questions that Temporal does not surface.
- Temporal is infrastructure that wraps the existing `runAgent`/`runOrchestrationLoop` unchanged; it cannot invalidate current architectural choices.
- A richer tool set is required before the equity research anchor scenario (Sprint 6) can be validated at all.

Temporal + Redis durability moves to Sprint 4.

### New tools

Three tools added to the agent loop alongside the existing five (Sprint 2) and three file tools (Sprint 1):

| Tool | Arguments | Description |
|------|-----------|-------------|
| `SearchWeb` | `query: string` | Brave Search API → markdown result list (title, url, snippet). Also saves results as an artifact in the shared artifacts folder. Not registered if `BRAVE_SEARCH_API_KEY` is absent. |
| `FetchUrl` | `url: string`, `query?: string` | HTTP GET → text extraction (Readability for HTML; mupdf for PDF). Downloads inline images. Saves artifact to shared folder. Returns artifact ID + content preview. |
| `InspectImage` | `path: string` | Passes image file to vision LLM via `completeSimple`. Returns text description. Accepts any image path — standalone image or one extracted from a document. |

DOCX and XLSX parsing deferred to Sprint 5.

### Library choices

Confirmed before implementation started:

| Concern | Library | Notes |
|---------|---------|-------|
| HTML extraction | `@mozilla/readability` + `jsdom` | Same as MAGI_V2; accurate article extraction |
| PDF text + image extraction | `mupdf` (npm) | Official Node.js binding; handles both text and image extraction |
| HTTP fetch | Node 18+ built-in `fetch` | No extra dependency; follows redirects by default |
| Vision LLM calls | `@mariozechner/pi-ai` `completeSimple` | No separate vision function; pass `ImageContent { type: "image", data: base64, mimeType }` inside a `UserMessage`. Works identically for Anthropic and OpenAI models. Check `model.input.includes("image")` before calling. |
| Artifact ID | `{slugified-hostname}-{YYYYMMDD}T{HHmmss}` | Human-readable, sortable; `{slugified-filename}-...` for uploads |

Image download limits per `FetchUrl` call: max 10 images, max 5 MB each. Inline `data:` URIs decoded directly.

### Artifact model

An artifact is a folder under the **shared mission artifacts directory** (`{workdir}/artifacts/<id>/`). It contains:

```
artifacts/apple-q4-20260222T143021/
  content.md          ← text rendition (Readability / mupdf extraction)
  image_001.png       ← images extracted from source (PDF pages, inline images)
  image_002.png
  meta.json           ← provenance sidecar
```

`meta.json` schema (Schema.org-inspired field names):

```json
{
  "id":             "apple-q4-20260222T143021",
  "name":           "Apple Inc. Reports Fourth Quarter Results",
  "url":            "https://investor.apple.com/...",
  "query":          "Apple Q4 2025 earnings release",
  "fetchedBy":      "lead-analyst",
  "fetchedAt":      "2026-02-22T14:30:21Z",
  "encodingFormat": "text/html",
  "files": {
    "content":  "content.md",
    "images":   ["image_001.png", "image_002.png"]
  }
}
```

### User uploads

User-provided documents live in a separate `uploads/` folder alongside `artifacts/`. The folder is read-only for agents (by system prompt convention in Sprint 3; enforced by filesystem ACL in Sprint 4).

```
{workdir}/
  artifacts/          ← agent-generated (read/write)
  uploads/            ← user-provided (read-only for agents)
    q4-report-20260222T091500/
      content.md      ← text extracted at upload time
      image_001.png   ← images extracted at upload time
      meta.json       ← { uploadedBy: "user", filename: "q4-report.pdf", uploadedAt: ... }
```

Uploads follow the same artifact folder convention so agents discover them via the same Bash commands (`ls uploads/`, `cat uploads/*/meta.json`).

**Upload + prompt are delivered as one message.** The operator always uploads alongside a prompt; the CLI processes the file into `uploads/` first, then appends an upload notice to the message body before posting to the lead agent's mailbox:

```
Please analyse the attached Q4 earnings report and summarise the key risks.

---
Uploaded document: uploads/q4-report-20260222T091500/
Original filename: q4-report.pdf
Text and images have been extracted and are ready for analysis.
```

No separate notification message, no new tool, no change to `MailboxMessage` schema.

**`@path` upload syntax.** Works identically at startup, during an agent run (buffered readline), and at the "Mission paused" prompt. The readline handler scans for `@/absolute/path` or `@./relative/path` tokens, processes each file into `uploads/`, strips the tokens from the text, and appends upload notices before posting to the mailbox. The `--upload` startup flag is dropped in favour of inline `@path` everywhere.

**`/command` namespace reserved.** The readline handler checks for a `/` prefix before processing input as a message. This prevents future breaking changes and enables operator tooling without modifying the mailbox model. Sprint 3 ships `/help` only; further commands are added as needed.

| Command | Sprint 3 | Later |
|---------|----------|-------|
| `/help` | lists available commands | — |
| `/agents` | — | agent states from mental maps |
| `/artifacts` | — | `ls` of `artifacts/` |
| `/uploads` | — | `ls` of `uploads/` |
| `/step` | — | toggle step mode mid-session |
| `/cycles` | — | current cycle count / maxCycles |
| `/abort` | — | graceful abort |

| Sprint | uploads path | enforcement |
|--------|-------------|-------------|
| 3 | `{workdir}/uploads/` | system prompt instruction |
| 4 | `/missions/{missionId}/uploads/` | filesystem ACL (read-only for agent uid/gid) |

### Cross-agent sharing

All fetched content is written to the **shared** artifacts folder, never to a private per-agent path. This maps forward cleanly:

| Sprint | Shared artifacts path |
|--------|-----------------------|
| 3 | `{workdir}/artifacts/` — single shared workdir, all agents can read |
| 4 | `/missions/{missionId}/shared/artifacts/` — proper identity + ACL; agents publish explicitly |
| 5 | MongoDB registry + MinIO binary store; `PublishArtifact` tool registers content with full lineage |

Agents reference artifacts by ID or slug in PostMessage body text. No structural change to `MailboxMessage` in this sprint.

### Discoverability

Agents discover available artifacts using Bash — the same execution environment already available to them:

```bash
ls artifacts/
cat artifacts/*/meta.json
find artifacts/ -name "meta.json" | xargs grep "Apple earnings"
```

This mirrors the pi-mono `web-ui` pattern, where discoverability is a capability of the execution environment (pi-mono injects `listArtifacts()` / `listAttachments()` into a JS sandbox; our equivalent is Bash on the shared filesystem). No separate `ListArtifacts` tool is needed in this sprint.

### Implementation sequence

Steps are ordered by dependency. Do not advance past a gate step until its integration test passes.

```
Step 1  artifacts.ts
          generateArtifactId(url|filename) → slug+timestamp
          saveArtifact(workdir, fields) → writes artifacts/<id>/ + meta.json
          saveUpload(workdir, fields)   → writes uploads/<id>/  + meta.json

Step 2  FetchUrl — HTML only
          native fetch + Content-Type detection
          @mozilla/readability + jsdom → content.md
          parse <img src> tags → download up to 10 images (max 5 MB each)
          write artifact, return id + 500-char preview

Step 3  InspectImage
          read image file → base64
          build UserMessage with ImageContent { type:"image", data, mimeType }
          completeSimple(model, context) → return text description

──── GATE: integration test 1 must pass before step 4 ────

Step 4  Integration Test 1
          static http server (Node http.createServer) on dynamic port
          single-agent team config (word-count lead reused or new minimal config)
          seed: "Fetch http://localhost:{PORT}/with-image.html. Describe the image."
          assert: artifact folder exists, image_001.* exists, user message contains "cat"

Step 5  FetchUrl — PDF support
          mupdf: extract text → content.md
          mupdf: extract embedded images → image_001.png, image_002.png, …
          update meta.json files list

──── GATE: integration test 2 must pass before step 6 ────

Step 6  Integration Test 2 + fetch-share.yaml
          config/teams/fetch-share.yaml (lead + worker)
          two-agent test: lead fetches PDF, delegates image analysis to worker via Bash
          assert: one artifact folder, user message contains "dog" and "cat"

Step 7  SearchWeb
          BRAVE_SEARCH_API_KEY env var check → skip registration if absent
          Brave Search REST API → format top-N results as markdown
          save results as artifact (encodingFormat: "application/x-search-results")

Step 8  CLI: @path + /command
          readline handler: /prefix → handleCommand(); else → processMessage()
          /help lists available commands; unknown /cmd prints error
          @path scanning: extract @/abs or @./rel tokens, saveUpload(), append notice

Step 9  equity-research.yaml + build/lint/test clean
          add SearchWeb, FetchUrl, InspectImage to agent system prompts
          note uploads/ as read-only in system prompt
          npm run build && npm test && npm run lint all green
```

### Deliverables

- `packages/agent-runtime-worker/src/artifacts.ts` — `generateArtifactId()`, `saveArtifact()`, `saveUpload()`; artifact folder convention; `meta.json` writer
- `packages/agent-runtime-worker/src/tools/fetch-url.ts` — `FetchUrl` tool; Readability + jsdom (HTML), mupdf (PDF); image download/extraction; writes artifact folder + `meta.json`
- `packages/agent-runtime-worker/src/tools/inspect-image.ts` — `InspectImage` tool; `UserMessage` with `ImageContent`; `completeSimple` vision call
- `packages/agent-runtime-worker/src/tools/search-web.ts` — `SearchWeb` tool; Brave Search API client; conditional registration on `BRAVE_SEARCH_API_KEY`
- `packages/agent-runtime-worker/src/cli.ts` — `@path` upload syntax; `/command` dispatch; `/help` command
- `config/teams/fetch-share.yaml` — two-agent team config for Test 2
- `config/teams/equity-research.yaml` — updated with new tools in agent system prompts
- `testdata/documents/` — test assets (shared across all sprints, already present):
  - `with-image.html`, `cat.jpg`, `dog.png`, `test-pdf.pdf`
- **Integration test 1** — `fetch-inspect.integration.test.ts` (single agent, HTML + cat)
- **Integration test 2** — `fetch-share.integration.test.ts` (two agents, PDF + sharing)

### Deferred

- DOCX and XLSX parsing → Sprint 5
- `/agents`, `/artifacts`, `/uploads`, `/step`, `/cycles`, `/abort` slash commands → added as needed

### Integration tests

Both tests spin up a Node `http.createServer` static file server pointing at `testdata/documents/` in `beforeAll`, and tear it down in `afterAll`. The port is chosen dynamically to avoid clashes.

**Test 1 — Single agent: HTML fetch + image inspection**

Setup: static server serves `testdata/documents/`.

Task seeded to agent:
> "Fetch the page at http://localhost:{PORT}/with-image.html. It contains an image. Describe what the image shows and report back to me."

Expected flow:
1. Agent calls `FetchUrl` → downloads HTML + the linked `cat.jpg` → writes `artifacts/<id>/content.md` + `artifacts/<id>/image_001.jpg` + `meta.json`
2. Agent calls `InspectImage` on `image_001.jpg` → vision LLM returns description
3. Agent calls `PostMessage to: user` with the description

Assertions:
- One artifact folder exists under `{workdir}/artifacts/`
- `meta.json` contains `url`, `fetchedBy`, `fetchedAt`, `encodingFormat: "text/html"`
- `image_001.jpg` (or `.jpg`/`.png`) exists inside the artifact folder
- User message contains "cat" or "feline"

**Test 2 — Two agents: PDF fetch + cross-agent artifact sharing**

Setup: same static server. Two-agent team config (Lead + Worker), loaded from `config/teams/fetch-share.yaml` (to be created with Sprint 3 implementation).

Task seeded to Lead:
> "Fetch the PDF at http://localhost:{PORT}/test-pdf.pdf. It contains images of animals. Have Worker identify the animals in the images and report the findings back to me. I will then report to the user."

Expected flow:
1. **Lead** calls `FetchUrl` → PDF parsed → `artifacts/<id>/content.md` + `image_001.png` (dog) + `image_002.jpg` (cat) + `meta.json`
2. **Lead** calls `PostMessage to: worker` — includes the artifact folder path or ID
3. **Worker** uses `Bash` to read `artifacts/<id>/meta.json` and list the images — no second `FetchUrl` call
4. **Worker** calls `InspectImage` on each extracted image
5. **Worker** calls `PostMessage to: lead` with descriptions of both animals
6. **Lead** calls `PostMessage to: user` with the combined summary

Assertions:
- Exactly one artifact folder exists (Worker reused Lead's; no duplicate fetch)
- User message contains both "dog" (or "puppy") and "cat" (or "feline")

### Deferred from original Sprint 3 plan

- Temporal workflows (`AgentWorkflow`, activities, signals) → Sprint 4
- Redis Streams mailbox (replaces MongoDB mailbox) → Sprint 4
- Critical interrupt path (`critical_alert` signal → inner loop abort) → Sprint 4

### Exit criteria

Both integration tests pass. User message in Test 1 contains "cat" or "feline". User message in Test 2 contains both animal species. Exactly one artifact folder is created in Test 2 (Worker reads Lead's artifact via Bash; no duplicate fetch). `npm run test:integration` exits 0.

---

## Sprint 4 — Durability: Temporal, Redis Mailbox, Identity, and Workspace

**Goal: production-grade durability and agent isolation. Workflows survive crashes. Agents have private homes and a shared mission folder with enforced ACLs. Temporal + Redis replace the Sprint 2 in-process orchestration and MongoDB mailbox.**

Deliverables:

**Durability (moved from original Sprint 3):**
- Temporal workflow wrapping the agent runner: `AgentWorkflow` with outer-loop Activity and inner-loop Activity
- Temporal signals: `inbound_message`, `schedule_fire`, `critical_alert`, `abort`
- `mailbox-service`: Redis Streams replacing the MongoDB mailbox; `mailbox:{agent_id}` streams with consumer groups; durable delivery with `XACK`. The mailbox tools (`ListTeam`, `ListMessages`, `ReadMessage`, `PostMessage`) are unchanged — only the backend swaps.
- Critical interrupt path: `critical_alert` signal → `getSteeringMessages()` hook → clean abort of inner loop → requeue task in Mental Map
- Workflow survives worker crash and resumes without data loss (Temporal replay)

**Identity, workspace, and ACL:**
- `identity-access-service`: agent identity schema, uid/gid assignment, role-to-policy mapping
- `workspace-manager`: provisions `/home/agents/{agent_id}`, `/missions/{mission_id}/shared/{role}` (including `shared/artifacts/`), and `/missions/{mission_id}/uploads/` with correct Linux ACLs (`setfacl`)
- Sprint 3 `{workdir}/artifacts/` promoted to `/missions/{missionId}/shared/artifacts/` — agents publish explicitly; `FetchUrl` writes here by default
- Sprint 3 `{workdir}/uploads/` promoted to `/missions/{missionId}/uploads/` — read-only (`r-x`) for all agent uid/gids; operator process retains write access
- Operations hooks in all file and bash tools enforce workspace policy; write to an unpermitted path fails with a clear policy-violation error (not a silent OS error)
- Tool registration filtered per role at agent instantiation — the agent never sees tools it cannot use
- Dev/prod workspace isolation: dev and prod paths are separate; publishing to prod from a dev agent is rejected at the tool level
- Team config YAML compiled to runtime `AgentIdentity` + tool list at mission startup
- `mission-api` stub: REST endpoint to start a mission from a team config file
- **Unit tests (TDD)**: ACL policy evaluation (pure function: given `(agent_id, path, action)` → `allow/deny`); tool registration filtering (given role policy, assert exact tool list)
- **Integration tests**: Temporal crash recovery (kill worker mid-Activity, assert workflow resumes); Redis durable re-delivery after consumer death before `XACK`; full `setfacl` workspace provisioning roundtrip

Exit criteria: Agent workflow survives a simulated worker crash and resumes correctly. Agent attempting to write outside its allowed paths receives a policy denial. Two agents with different role policies demonstrate correct access separation on shared folders including `shared/artifacts/`. All integration tests pass against real Redis and Temporal test server.

---

## Sprint 5 (2026-05-04 to 2026-05-15): Execution, Web, and Data Tools

**Goal: agents can run programs, browse the web, and process data.**

Deliverables:
- `ExecProgram`: starts command in sandbox (Docker rootless), returns `program_id` immediately (non-blocking)
- `ProgramStatus`, `ReadLogs`, `StopProgram`: polling and control for running programs
- Failure alerts: if a running program exits with error, the outer loop receives a mailbox message
- `BrowseWeb`: Playwright-based browser worker; returns structured content + provenance metadata (URL, timestamp, content hash)
- `FetchData`: HTTP pull with mandatory provenance recording; auto-registers images via AgentAssetRegistry
- `AnalyzeData`: runs a script or notebook in the execution sandbox; returns structured outputs + artifact refs
- `PublishArtifact` wired to MinIO with full lineage metadata (derived_from, tool_run_id, source_urls)
- Mixed execution pools: shared pool for low-risk tasks, isolated per-agent containers for code execution
- **Integration tests**: `ExecProgram` + `ReadLogs` + `StopProgram` lifecycle using `MockLLMProvider`; `PublishArtifact` lineage roundtrip (assert `derived_from`, `tool_run_id`, `source_urls` are all present and queryable); `FetchData` provenance metadata completeness

Exit criteria: Data scientist agent writes a Python analysis script, runs it via `ExecProgram`, monitors its output via `ReadLogs`, reads the result, and publishes a dataset artifact to MinIO with full lineage. A junior analyst agent fetches a web page via `BrowseWeb` and stores the content as a raw_data artifact. All integration tests pass.

---

## Sprint 6 (2026-05-18 to 2026-05-29): Equity Research Team MVP

**Goal: the full anchor scenario runs end-to-end.**

Deliverables:
- Full team config: Lead Analyst + 1 Junior Analyst + 1 Data Scientist + Watcher/Alert agent
- Scheduled daily cycle via Temporal schedules: 06:00 ingestion trigger → Junior collects data → Data Scientist runs analysis → Lead synthesises → 08:30 morning brief published
- Intraday event-driven flow: Watcher monitors thresholds; `critical_alert` when threshold breached; Lead's inner loop is interrupted, outer loop reprioritises
- Role prompts and Mental Map section templates for each agent type
- Report assembly: Lead Analyst composes the morning brief from artifact refs collected during the cycle; every claim in the report has at least one source artifact in its lineage
- Confidence scores required on all forecasts; conflicting signals trigger a review task instead of silent averaging
- All inter-agent messages and artifact lineage persisted and queryable via MongoDB
- Preliminary dev→prod artifact promotion check (manual approval via API call; full UI deferred to Sprint 7)

Exit criteria: Team completes one full daily cycle without manual intervention. Morning brief artifact is published with at least 5 cited sources. Watcher fires at least one alert during an injected threshold breach test. Full audit trail queryable: claim → artifact → tool run → source URL.

---

## Sprint 7 (2026-06-01 to 2026-06-12): Reliability and Quality Gates

**Goal: the system runs unattended for 5 days and meets SLOs.**

Deliverables:
- Human approval gate for morning brief publication (API-driven; operator calls `/approve/{artifact_id}` before prod publish)
- Runbooks for common failure modes: source feed outage, missed publish SLA, worker crash, mailbox delivery failure
- Retry and backoff policy for all Temporal activities
- Alert deduplication in the Watcher agent (prevent alert storm on sustained threshold breach)
- **Evaluation harness** (`eval/` directory, run on demand with real LLMs — not part of CI):
  - Citation coverage per report (assert ≥ 90%, zero uncited claims)
  - `nextAction` is always a valid enum value across 50 runs (structural correctness)
  - Mental Map always has exactly one `in-progress` task when inner loop is running
  - Watcher fires an alert within 2 turns of an injected threshold breach
  - No `prod` artifact published from a `dev` agent (policy enforcement under real LLM load)
  - Report freshness SLA compliance across a 5-day golden scenario
- 5-day unattended run with SLO compliance for the equity research mission

Exit criteria: 5 consecutive daily cycles complete within SLA. Evaluation harness reports citation coverage ≥ 90% and zero uncited claims in morning briefs. All evaluation scenarios pass on 3 consecutive runs. Common failure modes tested against runbooks.

---

## Sprint 8 (2026-06-15 to 2026-06-26): Work Product Layer UI

**Goal: operators can consume outputs and triage alerts without touching the API.**

Deliverables:
- Evaluate `pi-mono/packages/web-ui` (`<pi-chat-panel>`, message components, artifact renderers) vs MAG_v2 Vue.js frontend for the Work Product Layer. Adopt whichever integrates faster with MAGI V3's backend.
- **Mission Inbox**: active missions, current agent task (from Mental Map `#tasks` section), pending queue with priority scores and rationale, SLA/overdue indicators
- **Report Center**: generated reports, approval state, publication history, diff across versions
- **Alert Center**: severity-based alert feed, ack/escalate/snooze controls, audit trail
- **Ask Console**: Q&A against current mission artifacts with citations and confidence
- **Evidence Explorer**: claim → artifact → tool run → source URL lineage trace
- Mental Map read-only view for each agent (operator can see what the agent is thinking and why)
- `artifact://` reference resolution in the UI (mirrors `magi://` from MAG_v2)

Exit criteria: Operator can complete all six Phase 1 flows (Mission Inbox, Report Center, Alert Center, Ask Console, Evidence Explorer, Control Room) without CLI intervention. Every displayed claim links to at least one source artifact. Alert ack/escalate/snooze are durable and visible in audit trail.

---

## Sprint 9 (2026-06-29 to 2026-07-10): Cloud Burst and Scale-Out

**Goal: the system runs on Kubernetes with autoscaling and tenant isolation.**

Deliverables:
- Kubernetes deployment: Temporal workers as Deployments, execution sandboxes as Jobs, MinIO → S3, Redis cluster
- Autoscaling: HPA on agent-runtime-worker based on Temporal task queue depth
- Quotas and budgets: per-mission token spend and LLM call limits enforced in agent-runtime-worker
- Tenant isolation: missions run in separate Kubernetes namespaces with Pod Security Standards enforced; no cross-mission data leakage
- Cloud workspace model: Linux ACL policy objects translated to Kubernetes RBAC + pod security context equivalents
- Environment parity: local dev setup mirrors cloud topology (docker-compose equivalent)

Exit criteria: 50 concurrent agent tasks across 3 missions with bounded cost. Cross-mission isolation test: agent in mission A cannot access artifacts or mailbox of mission B. Local dev environment boots with `docker-compose up` and runs the full equity research cycle.

---

## Sprint 10 (2026-07-13 to 2026-07-24): Hardening and Launch Prep

Deliverables:
- Disaster recovery drills: worker crash, MongoDB failover, Redis failover — all with Temporal replay validation
- Red-team prompt suite: prompt injection attempts, privilege escalation attempts, cross-agent data exfiltration attempts via crafted mailbox messages
- Portfolio Layer and Team Design Layer management via validated config files with full change history (already built; Sprint 10 adds config diff UI and audit log export)
- Production checklist review
- Launch readiness review

Exit criteria: DR drills pass. Red-team findings resolved or accepted with documented mitigations. Launch readiness review signed off.

---

## Deferred Items

These are explicitly out of scope until after launch:

- **Portfolio Layer UI** — create/manage teams, mandates, budgets via UI (managed via config files until then)
- **Team Design Layer UI** — agent roster, role-capability matrix, ACL editor (same)
- **Artifact promotion UI** — currently an API call; full approval workflow UI deferred
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
