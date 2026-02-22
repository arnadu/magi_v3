# MAGI V3 — Technical Specification

## 1. Overview

MAGI V3 is an autonomous multi-agent system where teams of AI agents run long-horizon missions. Agents write and run code, browse the web, process data, communicate with teammates, and publish work products.

The architecture makes three advances over MAGI V2:
1. **Durable orchestration** — agent lifecycles are Temporal workflows; they survive crashes, support pause/resume, and respond to schedules and inbound messages.
2. **Sandboxed execution** — agents run with enterprise-style identity (uid/gid, home dirs, ACL-governed shared folders), with execution isolated per agent.
3. **Multi-agent coordination** — agents communicate through a structured mailbox system and collaborate on missions via shared artifact references.

MAGI V2's codebase (`/home/remyh/ml/MAGI_v2/MAG_v2`) and pi-mono (`/home/remyh/ml/MAGI_v2/pi-mono`) provide the foundation. V3 does not rewrite the agent loop or tool primitives from scratch — it wraps and extends proven implementations.

---

## 2. System Architecture

### Control Plane (stable, evolves slowly)

| Service | Responsibility |
|---------|---------------|
| `mission-api` | REST API — create/update missions, team composition, mandates, policies |
| `orchestrator` | Temporal workflows for agent lifecycles |
| `identity-access-service` | Agent identities, roles, uid/gid mapping, ACL policy objects |
| `mailbox-service` | Durable inter-agent messaging via Redis Streams |
| `state-store` | MongoDB — Mental Maps, conversation history, artifact metadata, event log |
| `observability` | OpenTelemetry traces, metrics, log correlation |

### Execution Plane (evolvable backends)

| Service | Responsibility |
|---------|---------------|
| `agent-runtime-worker` | Temporal activity worker — runs outer and inner agent loops |
| `workspace-manager` | Provisions agent home dirs and mission shared folders with ACL templates |
| `execution-runner` | Shared worker pool + isolated per-agent pools for shell/code execution |
| `browser-runner` | Playwright-based browse/download pipeline |
| `data-processing-runner` | Parsers, ETL, notebooks, analytics |
| `artifact-store` | MinIO (local) / S3-compatible (cloud) for artifact binary data |
| `artifact-promotion-service` | Controlled dev→prod release path (Sprint 5+) |

### Technology Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript throughout |
| Durable orchestration | Temporal |
| Agent loop primitives | `@mariozechner/pi-agent-core` (pi-mono) |
| LLM provider abstraction | `@mariozechner/pi-ai` (pi-mono) |
| State / Mental Maps | MongoDB |
| Messaging | Redis Streams with consumer groups |
| Object storage | MinIO (local) / S3-compatible (cloud) |
| Observability | OpenTelemetry |
| Container isolation | Docker rootless + seccomp (local), gVisor / Firecracker (cloud) |
| Filesystem permissions | Linux ACLs (`setfacl`) |
| Cloud scale-out | Kubernetes |

---

## 3. Agent Loop Architecture

### Core concept: two-tier loop

Every agent runs two nested loops at different levels of abstraction:

```
OUTER LOOP — planning tier
  Purpose:    maintain the Mental Map, process inbound messages, prioritize tasks
  Tools:      ReadMailbox, UpdateMentalMap, SendMailboxMessage, ReadArtifact (scan only)
  NOT allowed: ExecProgram, BrowseWeb, AnalyzeData — execution tools are inner-loop only
  Loop impl:  same LLM→tool→LLM pattern, but constrained toolset and planning prompt
  Terminates: when Mental Map is current and top task is identified

        ↓  dispatches top task from Mental Map  ↓

INNER LOOP — execution tier
  Purpose:    execute a single task to completion
  Tools:      full toolkit (file, bash, web, data, mailbox, artifact tools)
  Loop impl:  pi-agent-core's agentLoop()
  Terminates: when nextAction signals done, blocked, or escalate

        ↓  signals Temporal workflow on completion  ↓
        (workflow triggers outer loop again)
```

### Temporal workflow model

The Temporal workflow is the long-lived envelope around both loops. It maintains minimal durable state and reacts to external triggers.

**Workflow state:**
```typescript
interface AgentWorkflowState {
  agentId: string
  missionId: string
  mentalMapDocumentId: string      // MongoDB document ID — the Mental Map is the rich state
  innerLoopRunning: boolean
  pendingMessageIds: string[]      // mailbox message IDs queued since last outer loop
}
```

**Triggers (Temporal signals):**
- `inbound_message(messageId)` — new mailbox message; queued if inner loop is running, processed immediately otherwise
- `schedule_fire(triggerName)` — scheduled event (e.g., daily 06:00 ingestion)
- `critical_alert(messageId)` — high-urgency interrupt; triggers immediate steering of the running inner loop
- `abort` — graceful shutdown

**Activity sequence:**
```
loop forever:
  1. [OUTER LOOP ACTIVITY]  run outer loop → updates Mental Map → returns top task
  2. [INNER LOOP ACTIVITY]  run inner loop for top task → updates Mental Map on completion
  3. if pending messages or scheduled trigger: go to 1
  4. else: workflow.condition() — block until next signal
```

**Critical interrupt path:**
When a `critical_alert` signal arrives while the inner loop is running, the workflow delivers a steering message to the running Activity. pi-agent-core's `getSteeringMessages()` hook picks it up after the current tool call completes, skips remaining tool calls, and terminates cleanly. The outer loop then re-evaluates priorities.

### stop conditions and nextAction

Both loops use structured JSON output to signal their termination state. The LLM produces this in its final response turn (tools are disabled on the penultimate call to force a structured response — a pattern from MAG_v2).

**Outer loop nextAction values:**
- `triage_complete` — Mental Map updated, top task identified; dispatch inner loop
- `waiting_for_teammate` — top task is blocked on a dependency; pause until signal

**Inner loop nextAction values:**
- `publish_and_stop` — task done; artifacts published, outbound messages queued; return to outer loop
- `wait_for_input` — needs human approval; Temporal workflow pauses on `condition()`
- `escalate` — unresolvable error, conflicting data, or policy violation; creates a human review task
- `continue` — (implicit; loop continues if tool calls are present)

The inner loop's `nextAction` response may also carry:
```typescript
{
  nextAction: "publish_and_stop",
  artifacts_published: ["artifact-id-1"],
  messages_to_send: [{ to: "junior-analyst-1", intent: "task_request", ... }],
  todos_to_add: [{ title: "...", priority_score: 80, depends_on: [...] }]
}
```
`todos_to_add` items are merged into the Mental Map by the outer loop on its next run.

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

### Redis Streams implementation

Each agent has a dedicated Redis Stream: `mailbox:{agent_id}`. The `mailbox-service` routes messages by `recipient.agent_id` or by role fan-out (publishes to all agents with matching `recipient.role`).

Consumer groups give durable delivery: a message stays in the stream until explicitly acknowledged. The `ReadMailbox` tool reads with `XREADGROUP`; `AckMailboxMessage` calls `XACK`. If an agent crashes mid-processing, the message remains unacknowledged and is re-delivered on restart.

The Temporal workflow watches for new stream entries and emits `inbound_message` signals; the `mailbox-service` bridges the two systems.

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

## 14. Codebase Reuse Summary

| Component | Source | Notes |
|-----------|--------|-------|
| Inner agent loop | `pi-agent-core` `agentLoop()` | Use directly; wire `getSteeringMessages` to Temporal signal handler |
| Outer agent loop | New, same loop pattern | Constrained toolset, planning prompt |
| `AgentMessage` types | `pi-agent-core` | Extend via declaration merging for V3 message types |
| LLM provider abstraction | `@mariozechner/pi-ai` | `streamSimple` + `EventStream` primitives |
| File tools | pi-mono `coding-agent/src/core/tools/` | Adopt `read`, `edit`, `write`, `ls`, `find`, `grep`, `bash` with Operations hooks |
| Image handling | MAG_v2 `imageService.ts` + `visionHelper.ts` | Description-first; adapt storage from MongoDB base64 to MinIO |
| AgentAssetRegistry | MAG_v2 `imageService.ts` | Adapt to hold MinIO keys instead of base64 data |
| UpdateMentalMap tool | MAG_v2 `Editor` tool | Surgical HTML patch by element ID |
| Provider abstraction | MAG_v2 `llm/providers/` | Reference for multi-provider normalization patterns |
| Frontend (Work Product UI) | pi-mono `pi-web-ui` | Evaluate for Mission Inbox, Report Center in Sprint 6 |
| Multi-LLM model routing | MAG_v2 `modelCapabilities.ts` + reasoning effort pattern | Different models for outer loop (fast) vs inner loop (capable) |
