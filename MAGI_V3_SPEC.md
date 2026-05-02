# MAGI V3 — Technical Specification

## 1. Overview

MAGI V3 is an autonomous multi-agent system where teams of AI agents run long-horizon missions. Agents write and run code, browse the web, process data, communicate with teammates, and publish work products.

The architecture makes three advances over MAGI V2:
1. **Workspace persistence and isolation** — agents run with OS-level identity (Linux users, ACL-governed dirs); private and shared workspaces survive across sessions on persistent Fly.io volumes.
2. **Sandboxed tool execution** — all shell tools are dispatched via `sudo -u <linuxUser>` subprocesses with no secrets in the child environment; application-layer ACL validation runs before OS enforcement.
3. **Scalable multi-agent orchestration** — teams of agents coordinate via a structured mailbox; the daemon sleeps on a MongoDB Change Stream and wakes only when mail arrives or a scheduled trigger fires; each production mission runs as an isolated Fly.io machine.

---

## 2. System Architecture

### Production runtime

```
                      Developer / Operator
                            (browser)
                                │ HTTPS
                                ▼
        ┌───────────────────────────────────────────────────┐
        │  Control Plane   magi-control-{name}.fly.dev       │
        │  (always-on Fly.io machine)                        │
        │                                                    │
        │   Mission API          Fly Machines client         │
        │   (CRUD + lifecycle)   (provision/suspend/resume)  │
        │                                                    │
        │   Cron scheduler       HTTP reverse proxy          │
        │   (scheduled_messages  + Single-page UI            │
        │    delivery)                                       │
        └──────────────────────────┬─────────────────────────┘
                                   │  Fly private WireGuard
                                   │  http://[privateIp]:4000
                                   ▼
        ┌───────────────────────────────────────────────────┐
        │  Execution Plane   magi-missions-* app             │
        │  (on-demand Fly.io machine, one per active mission)│
        │                                                    │
        │   Daemon                                           │
        │   ├── Monitor server :4000  (SSE dashboard)        │
        │   ├── Tool API server :4001 (background jobs)      │
        │   └── Orchestration loop (Change Stream wake-up)   │
        │                                                    │
        │   Agent pool (sudo-isolated subprocesses)          │
        │   magi-w1 │ magi-w2 │ … │ magi-w5                 │
        │   (no secrets in child env; ACL-enforced dirs)     │
        │                                                    │
        │   Workspace /missions/{id}/  (Fly Volume, 10 GB)   │
        │   ├── shared/  (git repo, skills, research, jobs)  │
        │   └── home/{user}/missions/{id}/  (per-agent)      │
        └──────────┬────────────────────────────────────────┘
                   │  outbound only
        ┌──────────┼──────────┬──────────────┐
        ▼          ▼          ▼              ▼
    MongoDB    Anthropic   Brave         FRED / FMP /
    Atlas      API         Search API    NewsAPI / etc.
```

### CI/CD pipeline

```
  Developer
      │
      │  git push origin main
      ▼
  GitHub (arnadu/magi_v3)
      │
      ├── packages/agent-runtime-worker/**  ──▶  build-execution-image.yml
      │   packages/agent-config/**               │  docker build
      │   packages/skills/**                     │  docker push
      │   config/**                              ▼
      │                              registry.fly.io/magi-missions-dev:latest
      │                              (pulled by new Execution Plane machines)
      │
      └── packages/control-plane/**   ──▶  deploy-control-plane.yml
          packages/agent-config/**          │  flyctl deploy
                                            ▼
                                       magi-control-dev.fly.dev
                                       (rolling restart)
```

For local development setup and environment variables, see [USER_GUIDE.md](USER_GUIDE.md).

### Packages

| Package | Role |
|---------|------|
| `packages/control-plane/` | Express API, Fly Machines client, cron scheduler, HTTP reverse proxy, single-page UI |
| `packages/agent-runtime-worker/` | Daemon, orchestration loop, agent runner, monitor server (:4000), tool API server (:4001) |
| `packages/agent-config/` | Zod schema for team YAML; `loadTeamConfig()`, `parseTeamConfig()` |
| `packages/skills/` | Platform skills: `skill-creator`, `git-provenance`, `inter-agent-comms`, `run-background`, `schedule-task` |

### Technology Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript throughout |
| Linter / formatter | Biome |
| LLM provider | `@mariozechner/pi-ai` — `completeSimple()` wraps Anthropic API |
| State store | MongoDB (conversations, mailbox, llmCallLog, scheduled_messages) |
| Process supervision | pm2 (local dev); node-cron (scheduling) |
| Browser automation | Playwright + Stagehand |
| Cloud | Fly.io (control plane always-on; execution plane on-demand machines) |
| Container isolation | Docker + Linux ACLs (`setfacl`) + sudo subprocess isolation |
| Filesystem permissions | Linux ACLs (`setfacl`) |

---

## 3. Agent Loop Architecture

### Execution model

```
runOrchestrationLoop()           ← TypeScript scheduler, no LLM calls
  │
  │  sleep on MongoDB Change Stream
  │  (mailbox or scheduled_messages collection)
  │
  │  on wake: for each agent with unread mail
  │           in supervisor-depth order (supervisors run before reports)
  │
  └─▶  runAgent(agentId, inboxMessages)
         │
         ├── load conversation history from MongoDB
         ├── run reflection if prior session was large
         │   (compacts history → cumulative summary → updated Mental Map)
         │
         └─▶  runInnerLoop()     ← LLM → tool → LLM until no tool calls
                │
                ├── build system prompt (role + Mental Map + skills)
                ├── LLM call (Claude via completeSimple)
                ├── execute tool calls (isolated subprocesses)
                ├── repeat
                └── terminate when LLM returns no tool_use blocks
```

**Cycle boundary:** the cycle ends when no agent has unread mail. The daemon then blocks on `collection.watch()` (Change Stream) and uses zero CPU until the next message arrives.

**Scheduling:** the control plane's `node-cron` heartbeat (runs every minute) queries `scheduled_messages` for documents whose `deliverAt ≤ now` and inserts them into `mailbox`, which fires the Change Stream and wakes the daemon.

**Session boundary:** each wakeup of an agent is one *session*. At the start of the next session, the prior session's raw messages are compacted into a cumulative narrative summary (see §4 — reflection). The agent always starts a new session with: system prompt (role + updated Mental Map + skills) → summary of prior sessions → new inbox messages.

### Tool execution isolation

All shell tools (`Bash`, `WriteFile`, `EditFile`) are dispatched via:
```
sudo -u <linuxUser> node dist/tool-executor.js
```
The child process receives only `PATH` and `HOME` — no `ANTHROPIC_API_KEY`, `MONGODB_URI`, or other secrets. Application-layer `checkPath` validation runs first; OS-level ACL enforcement runs in the child. Background job scripts (`magi-job`) similarly receive only the data API keys explicitly listed in `DATA_KEY_NAMES`.

### Termination

An agent turn terminates when `runInnerLoop` returns — i.e., when the LLM response contains no `tool_use` blocks. The agent is expected to call `PostMessage` before finishing if it has results to deliver. The orchestration loop then checks whether any other agent now has unread mail (from those messages) and runs them if so.

---

## 4. Mental Map

### Concept

The Mental Map is the agent's persistent working memory and planning document. It is:
- **Self-authored** — the agent writes it in whatever structure serves its role
- **Persistent** — stored in MongoDB, survives the stateless worker pattern
- **Injected as context** — included in every system prompt so the agent always has access to its current state
- **Observable** — rendered in the Mission Inbox UI so operators can see what the agent is thinking

The Mental Map is the agent's scratchpad and plan, not its deliverable. Deliverables are published to the artifact store via `PublishArtifact`.

### Document structure

The Mental Map is HTML with stable section IDs. The agent authors prose content freely; machine-readable metadata is carried in `data-*` attributes on task items.

```html
<section id="mission-context">
  <!-- agent's understanding of its role, mandate, current phase, env (dev/prod) -->
</section>

<section id="tasks">
  <ol>
    <li id="task-{id}"
        class="pending|in-progress|done|blocked"
        data-priority="{0-100}"
        data-deadline="{ISO timestamp or empty}"
        data-source="{message_id|schedule|self}">
      <!-- free-form prose: what the task is, why it matters, what context is needed -->
    </li>
  </ol>
</section>

<section id="working-notes">
  <!-- free-form notes: research findings, data observations, decisions made, constraints -->
</section>

<section id="waiting-for">
  <!-- items this agent is blocked on: teammate responses, human approvals, running programs -->
</section>
```

The `data-priority` attribute (0–100 continuous scale) is set by the outer loop's LLM. The Temporal workflow reads the top `pending` task by priority when dispatching the inner loop.

### UpdateMentalMap tool

Directly adapted from MAG_v2's `Editor` tool. Targets elements by `id` for surgical updates rather than rewriting the whole document.

```typescript
UpdateMentalMap({
  id: "tasks",          // target element ID
  update: "replace" | "append-child" | "prepend-child" | "remove",
  content: "<li ...>...</li>"   // new HTML (for replace/append/prepend)
})
```

The outer loop uses `UpdateMentalMap` to: add new tasks from inbound messages, reprioritize existing tasks, mark tasks done, and update working notes. The inner loop uses it to: record findings during execution, mark its assigned task done, and add `todos_to_add` items.

### Persistence

Each agent has one Mental Map document in MongoDB per active mission assignment. The document ID is stored in Temporal workflow state. On every outer and inner loop invocation, the agent loads the current Mental Map from MongoDB, operates on it, and persists changes via `UpdateMentalMap` tool calls (each call is an atomic patch to the MongoDB document). The stateless worker pattern is preserved — no in-memory state between activities.

---

## 5. Prompt Construction

### Outer loop prompt

```
You are the planning mind of {role} on mission {mission_id}.
Your job is to keep your Mental Map current and decide what to do next.
You are NOT executing tasks — only planning and coordinating.

Tools available: ReadMailbox, UpdateMentalMap, SendMailboxMessage, ReadArtifact

Current time: {ISO timestamp}
Upcoming deadlines: {list from task data-deadline attributes}

<mental-map>
{current Mental Map HTML}
</mental-map>

New events since last planning cycle:
{list of new mailbox messages with sender, intent, brief content}

Update your Mental Map to reflect these events, reprioritize your task queue,
and send any immediate acknowledgments. Stop when your Mental Map is current
and the top task is unambiguous.
```

### Inner loop prompt

```
You are {role} on mission {mission_id}.
Execute the following task to completion.

<mental-map>
{current Mental Map HTML}
</mental-map>

<current-task>
{content of the top task <li> element}
</current-task>

<workspace>
Environment: {dev|prod}
Home: /home/agents/{agent_id}
Shared folders: {list of accessible shared paths with r/w permissions}
</workspace>

When done, call PublishArtifact for any outputs, send relevant mailbox messages,
and return a nextAction response.
```

### Context assembly rules

1. **System prompt sections** are assembled in the order above. The Mental Map is always included in full (it is the agent's memory — truncating it would cause amnesia).
2. **Message history** contains only this agent's own turns (its LLM calls, tool calls, and results). Mailbox messages from other agents enter via the `<mental-map>` section (which the outer loop has already processed), not as raw turn history.
3. **Tool disable on penultimate call** — when the loop approaches `maxTurns - 1`, tools are removed from the call to force a structured `nextAction` response (MAG_v2 pattern).
4. **Context compaction** — when estimated token count exceeds 60% of context window, turns older than a rolling window are summarized into a compact text block prepended to the history. Recent turns are kept in full.

### Image handling — description-first (MAG_v2 pattern)

The description-first strategy from MAG_v2 is adopted unchanged:
1. **On upload/fetch**: generate a short AI description and store as metadata (`imageService.analyzeImageWithLogging()`).
2. **In message history**: inject `"Artifact {id} ({type}): {description}"` as text — no raw image data.
3. **On-demand analysis**: the agent calls `InspectImage(imageId, question)` when it needs detail from a specific image. The question and answer are logged for evidence lineage.
4. **Storage**: image binary data in MinIO (not MongoDB base64 blobs as in MAG_v2). The `AgentAssetRegistry` holds metadata only; resolves to MinIO pre-signed URLs when the LLM needs the actual bytes.

Token economy: ~80% reduction versus sending all images in every LLM call. The `magi://` virtual filesystem reference concept from MAG_v2 is adapted: Working Notes and published artifacts use `artifact://{artifact_id}` references; the Work Product UI resolves these to MinIO presigned URLs for display.

---

## 6. Tool System

### Tool definition pattern

All tools follow pi-agent-core's `AgentTool<Schema>` interface:

```typescript
interface AgentTool<TSchema extends TSchema> {
  name: string
  description: string
  inputSchema: TSchema                    // TypeBox schema — validated before execute()
  execute(
    toolCallId: string,
    args: Static<TSchema>,
    signal?: AbortSignal,
    onPartialResult?: (partial: AgentToolResult) => void   // streaming progress
  ): Promise<AgentToolResult>
}
```

Tools are instantiated with factory functions that receive `Operations` hooks for ACL enforcement (pi-mono pattern):

```typescript
const editTool = createEditTool({
  checkPath: (p) => workspacePolicy.assertWriteAllowed(agentId, p),
  afterWrite: (p, content) => auditLog.record(agentId, 'file_write', p)
})
```

### Tool sets by tier

**Outer loop tools** (planning only — no execution side effects):

| Tool | Source | Notes |
|------|--------|-------|
| `UpdateMentalMap` | New (adapted from MAG_v2 `Editor`) | Surgical HTML patch via element ID |
| `ReadMailbox` | New | Returns typed messages with intent, priority, artifact_refs |
| `AckMailboxMessage` | New | Acknowledge / claim / close a mailbox message |
| `SendMailboxMessage` | New | Send typed message to agent or role |
| `ReadArtifact` | New | Read artifact metadata + first N bytes for quick scan |

**Inner loop tools** (execution — full access within policy):

*File tools* — adopted directly from pi-mono `packages/coding-agent/src/core/tools/`:

| Tool | Notes |
|------|-------|
| `ReadFile` | Line-offset and limit support for large files |
| `EditFile` | Surgical string replacement with uniqueness validation (fails on ambiguous match) |
| `WriteFile` | Full file write |
| `ListDir` | Directory listing with filtering |
| `FindFiles` | Pattern-based file search |
| `GrepFiles` | ripgrep-backed content search |
| `Bash` | Shell execution with spawn hooks for sandboxing and audit |

*Image tools* — MAG_v2 pattern:

| Tool | Notes |
|------|-------|
| `InspectImage` | On-demand detailed analysis; question is required; logs call for evidence lineage |
| `FetchImage` | Download image from URL, register in AgentAssetRegistry, auto-describe |

*Execution tools* — new for V3:

| Tool | Notes |
|------|-------|
| `ExecProgram` | Start command in sandbox; returns `program_id` immediately (non-blocking) |
| `ProgramStatus` | Poll process state, exit code, cpu/mem |
| `ReadLogs` | Stream/tail logs with filters and line offsets |
| `StopProgram` | Clean process tree termination |

*Web and data tools* — new for V3:

| Tool | Notes |
|------|-------|
| `BrowseWeb` | Playwright-based navigate/extract/download; returns structured content + provenance |
| `FetchData` | Pull URL/API/file; mandatory provenance metadata (URL, timestamp, content hash) |
| `AnalyzeData` | Run script/notebook in sandbox; return structured outputs + artifact refs |

*Coordination tools* (also available in inner loop):

| Tool | Notes |
|------|-------|
| `SendMailboxMessage` | Send typed message mid-execution (e.g., request data from teammate) |
| `PublishArtifact` | Write to artifact store with metadata + lineage; returns `artifact_id` |

### Tool ACL enforcement

At agent instantiation, the tool factory receives workspace policy hooks derived from the agent's role config. The agent never sees tools its policy forbids — they are simply not registered in its tool list. Filtering at registration time, not in the prompt.

Example policy-derived filtering:
- Data Scientist in `dev`: has `ExecProgram`, `AnalyzeData`, `PublishArtifact` (to dev only)
- Lead Analyst in `prod`: has `PublishArtifact` (to prod), does NOT have `ExecProgram`
- Watcher: has `SendMailboxMessage` and `ReadMailbox` only — no file or execution tools

---

## 7. Agent Identity Model

Each agent has a stable enterprise-style identity assigned at team configuration time:

```typescript
interface AgentIdentity {
  agent_id: string              // stable, unique across missions
  uid: number                   // Linux uid for filesystem ownership
  gid: number                   // primary Linux gid (role group)
  supplementary_gids: number[]  // shared mission folder groups
  role: string                  // e.g., "lead-analyst", "data-scientist"
  policy_tags: string[]         // e.g., ["prod-read", "dev-write", "web-allowed"]
  mission_id: string
  environment: "dev" | "prod"
}
```

**Workspace paths:**
- Private home: `/home/agents/{agent_id}` (private, rwx for uid only)
- Mission shared: `/missions/{mission_id}/shared/{team_or_role}` (ACL-governed per role)
- `dev` and `prod` paths are isolated; cross-environment exchange only via promoted artifacts (Sprint 5+)

**ACL policy** is enforced at two levels:
1. **Linux ACLs** (`setfacl`) on actual filesystem paths — hard enforcement for code execution
2. **Operations hooks** in tool factories — enforced at the tool level for all file operations, even those not touching the filesystem directly (e.g., artifact publishing to the wrong environment)

---

## 8. Mailbox / Messaging

### Message schema

```typescript
interface MailboxMessage {
  message_id: string
  mission_id: string
  sender_agent_id: string
  recipient: { agent_id?: string; role?: string }  // one or the other
  intent: "task_request" | "data_request" | "result_submit" | "risk_alert" | "status_update"
  priority: "normal" | "high" | "critical"
  subject: string
  body: string                          // prose; may reference artifacts
  artifact_refs: string[]               // artifact IDs attached
  deadline?: string                     // ISO timestamp
  in_reply_to?: string                  // message_id this is a response to
  status: "unread" | "claimed" | "acked" | "closed"
  created_at: string
}
```

`critical` priority messages trigger the Temporal `critical_alert` signal, bypassing the normal triage queue and potentially interrupting the running inner loop.

### MongoDB implementation

Messages are stored as documents in the `mailbox` collection, scoped by `mission_id`. The daemon watches for new documents via a **Change Stream** (`collection.watch()` with `operationType: "insert"` filter); when a new message arrives the Change Stream cursor fires and the orchestration loop wakes immediately.

For role-based delivery (`recipient.role`), the sender looks up all agents in the team config with the matching role and inserts one document per agent.

**Scheduled messages** are stored separately in `scheduled_messages` with a `deliverAt` timestamp. The control plane's `node-cron` heartbeat (runs every minute) queries for `deliverAt ≤ now` documents, inserts them into `mailbox`, and marks them `status: "delivered"`. This fires the Change Stream and wakes the daemon.

Message durability relies on MongoDB write concern; the Change Stream cursor reconnects with exponential backoff on network errors.

---

## 9. Artifact System

### Artifact types

`dataset`, `report`, `alert`, `code`, `notebook`, `chart`, `model`, `raw_data`

### Artifact metadata

```typescript
interface Artifact {
  artifact_id: string
  mission_id: string
  producer_agent_id: string
  artifact_type: ArtifactType
  title: string
  description: string
  environment: "dev" | "prod"
  storage_key: string             // MinIO/S3 object key
  content_hash: string            // SHA-256 for integrity
  size_bytes: number
  lineage: {
    derived_from: string[]        // parent artifact IDs
    tool_run_id: string           // which tool invocation produced this
    source_urls?: string[]        // for data fetched from the web
  }
  status: "draft" | "published" | "promoted" | "superseded"
  created_at: string
}
```

Lineage is mandatory. Every artifact traces back to its sources (other artifacts or web URLs) and the tool run that produced it. This is what powers the Evidence Explorer in the Work Product UI.

### Dev/prod separation

Dev artifacts are published to the `dev` MinIO bucket prefix. Promotion to `prod` requires the `PromoteArtifact` workflow (Sprint 5+), which runs validation checks and requires explicit approval before moving the artifact to the `prod` prefix and updating its status to `promoted`.

---

## 10. Workspace Model

### Directory layout

```
/home/agents/{agent_id}/            private workspace (rwx uid only)
  scratchpad/                       temporary working files
  programs/                         code the agent writes and runs
  downloads/                        data fetched from web/APIs

/missions/{mission_id}/
  shared/
    team/                           all agents on this mission (r for all, w by role policy)
    {role}/                         role-specific shared folder (e.g., data-scientist/)
  artifacts/                        symlinks to promoted artifact working copies
```

### ACL enforcement

The `workspace-manager` service provisions directories and sets ACLs when an agent joins a mission:

```bash
# Create agent home
mkdir -p /home/agents/{agent_id}
chown {uid}:{gid} /home/agents/{agent_id}
chmod 700 /home/agents/{agent_id}

# Set shared folder ACL
setfacl -m u:{uid}:rwx /missions/{mission_id}/shared/team    # if policy allows write
setfacl -m u:{uid}:r-x /missions/{mission_id}/shared/team    # if policy allows read-only
```

Tool `Operations` hooks enforce the same policy in software before any filesystem call, providing a consistent enforcement layer regardless of whether the underlying path is local or cloud-mounted.

---

## 11. Configuration (Config-First)

Until Portfolio and Team Design UIs ship, all configuration is YAML files validated against JSON schemas.

### Team config (`config/teams/{team_id}.yaml`)

```yaml
team_id: equity-research-eu
mission_type: equity_research
environment: prod

agents:
  - agent_id: lead-analyst-01
    role: lead-analyst
    model: claude-sonnet-4-6
    max_turns_per_run: 20
    policy_tags: [prod-read, dev-read, web-allowed]
    tools: [ReadMailbox, AckMailboxMessage, SendMailboxMessage, UpdateMentalMap,
            ReadFile, EditFile, WriteFile, ListDir, FindFiles, GrepFiles,
            BrowseWeb, FetchData, InspectImage, PublishArtifact]
    workspace:
      home: /home/agents/lead-analyst-01
      shared_read: [/missions/eq-eu/shared/team]
      shared_write: []

  - agent_id: data-scientist-01
    role: data-scientist
    model: claude-sonnet-4-6
    max_turns_per_run: 30
    policy_tags: [dev-write, web-allowed, exec-allowed]
    tools: [ReadMailbox, AckMailboxMessage, SendMailboxMessage, UpdateMentalMap,
            ReadFile, EditFile, WriteFile, ListDir, FindFiles, GrepFiles, Bash,
            ExecProgram, ProgramStatus, ReadLogs, StopProgram,
            FetchData, AnalyzeData, InspectImage, PublishArtifact]
    workspace:
      home: /home/agents/data-scientist-01
      shared_read: [/missions/eq-eu/shared/team]
      shared_write: [/missions/eq-eu/shared/data-scientist]

schedules:
  - name: daily-ingestion
    cron: "0 6 * * 1-5"          # 06:00 weekdays
    recipient_role: junior-analyst
    message:
      intent: task_request
      priority: high
      subject: "Daily ingestion cycle"
      body: "Fetch and process today's market data per mandate."
      deadline: "T+2h"           # 2 hours from fire time
```

Required support (Sprint 0): schema validation, dry-run compile to runtime policy objects, diff and change history for auditability. Invalid configs that would create ACL conflicts or invalid tool assignments must be rejected at validation time.

---

## 12. Testing Strategy

### Three-tier taxonomy

**Tier 1 — Unit tests** (TDD, fast, deterministic, run on every commit via `npm test`)

These cover pure functions and deterministic logic only. No LLM calls, no network, no filesystem side effects.

| What | TDD approach |
|------|-------------|
| Config YAML validation | Write invalid config variants; assert exact error messages |
| ACL policy evaluation | Property-based tests over `(agent_id, path, action)` → `allow/deny` |
| `UpdateMentalMap` HTML patching | Assert DOM state after each `replace/append/remove` operation |
| `nextAction` structured output parsing | Given raw LLM response strings (valid and malformed), assert parse results |
| Mailbox message routing | Given message + agent roster, assert which streams receive it |
| Artifact lineage validation | Assert all required lineage fields are present and well-formed on `PublishArtifact` |
| Tool registration filtering | Given a role policy, assert exact tool list produced |
| Context assembly | Assert assembled prompt contains correct sections; assert tools absent when disabled |
| Token estimation and compaction trigger | Assert compaction fires at the correct threshold |
| Operations hook enforcement | Assert hook throws a typed policy error when path is outside allowed set |

**Tier 2 — Integration tests** (run on PR, use real infrastructure with `MockLLMProvider`)

These test plumbing and infrastructure guarantees against real MongoDB, Redis, MinIO, and the Temporal test server. LLM calls are replaced by `MockLLMProvider` — a scripted stub that returns deterministic `nextAction` values and tool calls, verifying the entire loop machinery without actual model inference.

MongoDB in integration tests runs via `mongodb-memory-server` — the real MongoDB binary in-process, zero external dependency, real query semantics. No JSON file backends or mock drivers. This gives full confidence in repository implementations without requiring a running MongoDB service.

Seed-and-run pattern (adapted from MAG_v2 `backend/tests/integration/`):
1. **Seed**: write a specific task into an agent's Mental Map; pre-load Redis mailbox with test messages
2. **Run**: execute the two-tier loop using `MockLLMProvider` with a scripted response sequence
3. **Assert**: Mental Map has correct task status, artifact published with correct lineage, outbound messages sent

Key integration tests per sprint:
- *Sprint 1*: Mental Map MongoDB roundtrip (patch → reload → assert idempotency); full outer+inner loop run
- *Sprint 2*: Temporal crash recovery (kill worker mid-Activity, assert resume on correct task); Redis durable re-delivery after consumer death before `XACK`
- *Sprint 3*: Workspace provisioning (`setfacl` roundtrip); OS-level write rejection matches policy-level rejection
- *Sprint 4*: `ExecProgram`/`ReadLogs`/`StopProgram` lifecycle; `PublishArtifact` full lineage roundtrip

`MockLLMProvider` interface:
```typescript
interface MockLLMProvider {
  // Queue up responses in order; each call to the LLM pops one
  queue(responses: MockResponse[]): void
}

interface MockResponse {
  content?: string                        // the msgToUser / nextAction JSON
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>
}
```

**Tier 3 — Evaluation tests** (`eval/` directory, run on demand with real LLMs, not in CI)

These run the full system against golden scenarios and assert on outcome properties, not exact outputs. They are non-deterministic in detail but stable in aggregate over multiple runs.

```
eval/
  scenarios/
    equity-research/
      daily-cycle.eval.ts        # full daily cycle; assert citation coverage ≥ 90%
      threshold-alert.eval.ts    # inject breach; assert alert within 2 turns
      policy-enforcement.eval.ts # dev agent attempts prod publish; assert denial
  runner.ts                      # run all scenarios, produce pass/fail report
```

Assertions in evaluation tests check structural and policy properties, not content:
- `nextAction` is always a valid enum value (never a free-form string)
- Every published artifact has at least one `derived_from` entry or one `source_url`
- Mental Map always has exactly one `in-progress` task when the inner loop is running
- No `prod` artifact published from a `dev`-environment agent across 50 runs
- Watcher fires an alert within N turns of a threshold breach (tunable)
- Report freshness SLA is met on ≥ 90% of runs over a 5-day scenario

Do NOT write evaluation tests for: prompt wording, LLM tool selection choices, or the specific text content of generated reports.

### Repository interfaces

The persistence layer uses three thin, MongoDB-idiomatic repository interfaces. They are not backend-agnostic — they expose MongoDB-native constructs (document IDs, upsert semantics, projection) because abstraction over different backends would introduce a leaky ceiling the moment any MongoDB-specific feature is needed.

The interfaces are injectable, which is sufficient for testability: integration tests pass in a repository backed by `mongodb-memory-server`; production code passes in one backed by the real MongoDB connection.

```typescript
interface ConversationRepository {
  append(sessionId: string, messages: AgentMessage[]): Promise<void>
  load(sessionId: string): Promise<AgentMessage[]>
  truncate(sessionId: string, keepLast: number): Promise<void>
}

interface MentalMapRepository {
  load(agentId: string): Promise<MentalMapDocument | null>
  save(agentId: string, doc: MentalMapDocument): Promise<void>
  patch(agentId: string, patch: MentalMapPatch): Promise<MentalMapDocument>
}

interface ArtifactRepository {
  create(artifact: Artifact): Promise<string>           // returns artifact ID
  get(artifactId: string): Promise<Artifact | null>
  queryByMission(missionId: string, filter?: ArtifactFilter): Promise<Artifact[]>
}
```

Interfaces are defined in Sprint 0. First implementations land in Sprint 1 alongside the inner loop.

### TestLogger

Adapted from MAG_v2's `TestLogger` pattern. In test mode (`NODE_ENV=test`), the agent runtime emits structured events to `TestLogger` instead of / in addition to the normal SSE/OTel streams. Integration tests subscribe to `TestLogger` events to assert on agent behaviour without parsing logs.

```typescript
// In integration tests
const logger = new TestLogger({ verbose: true })
const events = await runWithLogger(agentWorkflow, logger)

expect(events).toContainEvent({ type: 'tool_execution_end', toolName: 'PublishArtifact' })
expect(events).toContainEvent({ type: 'mental_map_updated', sectionId: 'tasks' })
```

---

## 13. Observability

Every LLM call, tool execution, and Temporal activity emits OpenTelemetry spans with standard attributes:

- `agent.id`, `agent.role`, `mission.id`
- `llm.model`, `llm.turn`, `llm.tokens_in`, `llm.tokens_out`
- `tool.name`, `tool.call_id`, `tool.success`
- `artifact.id`, `artifact.type` (on publish)
- `mailbox.message_id`, `mailbox.intent` (on send/receive)

The Evidence Explorer in the Work Product UI traces a report claim back through: claim text → artifact → tool run (span) → source URL or parent artifact. The span tree provides the full provenance chain.

All LLM calls are logged with full context (system prompt, message history, raw response) to support the Explain functionality from MAG_v2. This log is write-once and is the audit record for alignment review.

---

## 14. External Dependencies and References

V3 is implemented from scratch but draws on patterns from two prior projects:

- **`@mariozechner/pi-ai`** — `completeSimple(model, context)` is the non-streaming LLM call used by `runInnerLoop`. This is the only direct runtime dependency on pi-mono.
- **MAGI v2** — Mental Map design (§4), image handling strategy (§5.4), and UpdateMentalMap tool semantics (§4.3) are adapted from v2's `Editor` tool and vision pipeline.
- **`pi-web-ui`** — Lit-based web component library; still a candidate for a future React frontend (Sprint 16+); not yet adopted.

For full details on these projects, see [docs/references.md](docs/references.md).
