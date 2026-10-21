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
| `packages/skills/` | Platform skills — every directory with a `SKILL.md` ships to every mission (`_platform/`); the cockpit's toggle list comes from the same directory via `GET /api/catalog`. Domain playbooks belong in a template's own `skills/` (e.g. `market-analysis-framework` under `config/teams/gold-digest/`) |

### Technology Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript throughout |
| Linter / formatter | Biome |
| LLM provider | `@mariozechner/pi-ai` — `completeSimple()` wraps Anthropic API |
| State store | MongoDB (conversations, mailbox, llmCallLog, scheduled_messages, agentTurnStats, missionStats) |
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

The Mental Map is the agent's scratchpad and plan, not its deliverable. Deliverables are files in the shared mission folder (committed by the daemon at the end of each turn); fetched and uploaded documents become artifacts under `shared/artifacts/`.

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

The `data-priority` attribute (0–100 continuous scale) is set by the agent during planning. Tasks are surfaced in order of priority in the system prompt.

### Mental-map tools

Targeted by element `id` for surgical updates rather than rewriting the whole document
(adapted from MAG_v2's `Editor` tool; `mental-map.ts`):

```typescript
mental_map_update({ target_id: "tasks", mode: "replace" | "append", content: "<li ...>...</li>" })
mental_map_add({ new_id: "task-42", parent_id: "tasks", content: "<li ...>...</li>" })
mental_map_remove({ target_id: "task-17" })
```

Agents use them to add tasks from inbound messages, reprioritize, mark tasks done, record findings
and keep working notes. Daemon-managed regions (`data-managed`, e.g. `#my-objectives`) are synced
from their real source at turn start and cannot be removed by an edit.

### Persistence

The current Mental Map travels with the conversation: each assistant message saved to
`conversationMessages` carries a `mentalMapHtml` snapshot, and a session starts from the most recent
one (or the agent's `initialMentalMap` on its first wakeup). The tools patch the in-memory copy for
the rest of the turn. No other state survives between sessions.

---

## 5. Prompt Construction

### Session prompt structure

Each agent session (`runInnerLoop`) is built from a single system message followed by the conversation:

```
[System message]
  {agent.systemPrompt}          ← full role description from team YAML (includes {{mentalMap}} substituted with current HTML)
  {current-time block}          ← UTC/Unix/day-of-week (+ local time if mission.timezone is set), rounded to 5 min
  {skills block}                ← skill instructions discovered from sharedDir

[User message: prior session summary]   ← only present if prior sessions exist and were reflected
  Sessions 1..N-1: {cumulative narrative summary written by reflection}

[User message: inbox]
  {one section per new mailbox message, with sender and body — machine alerts from
   system/scheduler repeated under one subject show only the 3 most recent, the rest
   summarised in one line}
```

The agent then runs `runInnerLoop`, making LLM calls and tool calls until the LLM response
contains no `tool_use` blocks. There is no separate "outer loop" or "planning LLM" — the single
LLM call sequence handles planning, tool execution, and message sending in one uninterrupted loop.

### Context rules

1. **Mental Map is always in full.** It is injected into the system prompt via `{{mentalMap}}` substitution — never truncated. It is the agent's persistent working memory.
2. **Message history is this agent's turns only.** Prior LLM calls, tool calls, and tool results for this agent within the current session. Cross-agent messages enter only via the inbox user message.
3. **Session boundary compaction.** At the start of a new session, `reflect()` is called if the prior session was large (peak input tokens ≥ 120k). Reflection writes a cumulative summary as a `SummaryMessage` and marks the prior session's raw messages as `compacted: true`. The LLM then sees the summary in place of the raw history. `convertToLlm` also calls `pruneEphemeralResults(out, 2)` so cross-session history is lean before the inner loop starts.
4. **In-session ephemeral pruning.** After each LLM call, if `usage.input + usage.cacheRead > 160,000` tokens (80% of the 200k window), `pruneEphemeralResults(messages, 2)` stubs the `content` of all ephemeral tool results (Bash, SearchWeb, FetchUrl, BrowseWeb, ReadFile, InspectImage) from every round except the two most recent, and strips `thinking` blocks from all but the most recent assistant message. MongoDB retains full content; agents can recover pruned results on demand via `AnalyzeMemories`.
5. **Skills block.** Appended to the system prompt by `formatSkillsBlock()`. Contains the content of each `SKILL.md` discovered in `sharedDir/skills/` (platform, team, and mission tiers).
6. **Current-time block.** Built by `buildTimeBlock()` (prompt.ts) and appended to every system prompt: UTC time (ISO-8601, minute precision) + day of week, Unix epoch, and — if `mission.timezone` is set in team YAML (an IANA name, e.g. `America/New_York`) — a local-time line. Rounded to the nearest 5 minutes, deliberately: the whole system prompt is sent as one cache_control block (pi-ai's Anthropic provider), and `buildSystemPrompt()` is rebuilt fresh before every LLM call in the inner loop (turn start *and* after every tool-call round), so a to-the-second timestamp would invalidate the cache on every call. 5-minute buckets keep the block genuinely current while typically staying stable across a turn's own tool-call iterations. Deliberately minimal — no derived signals like mission elapsed-time or market-hours status; a team whose domain needs that (e.g. equity research reasoning about NYSE hours) computes it from local time within its own `systemPrompt`, not the platform.

### Platform prompts

A team's agent prompts come from its config YAML. The text the platform itself sends to a model —
the mission copilot's system prompt and starting mental map, the Research sub-agent, reflection,
BrowseWeb's browser agent, the image description/OCR prompts, and the rendering note and
mental-map pointer appended to every agent's system prompt — lives as files in
`packages/agent-runtime-worker/prompts/`, loaded by `loadPrompt()` (`src/prompts.ts`). `{{name}}`
placeholders are filled in one pass by the caller; ones it does not pass (`{{mentalMap}}`,
`{{sharedDir}}`, `{{workdir}}`) are left for `buildSystemPrompt` to fill per session. Both Docker
images ship the folder, and the mission copilot can read it under `/opt/magi-src/`.

### Extended thinking

`CLAUDE_SONNET` runs with extended thinking enabled (`reasoning: "medium"`). Thinking blocks are visible in the LLM response but stripped from all but the most recent assistant message by `pruneEphemeralResults` before the next LLM call. `CLAUDE_HAIKU` (vision model) has thinking disabled — it is used for fast, cheap captioning where extended reasoning would be wasteful. OpenRouter models are silently skipped if `model.reasoning === false`.

### Image handling — description-first

Images fetched via `FetchUrl` or `BrowseWeb` are processed description-first:
1. **On fetch**: a vision LLM call (`VISION_MODEL`, default: `claude-haiku-4-5-20251001`) generates a short description and stores it in the artifact's `meta.json`.
2. **In conversation history**: images appear as text descriptions — no raw image bytes in history.
3. **On-demand analysis**: the agent calls `InspectImage(path, prompt?)` for detailed analysis of a specific image within its workdir.

Token economy: ~80% reduction versus sending all images in every LLM call.

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

Tools are instantiated with factory functions that receive `AclPolicy` hooks for path enforcement:

```typescript
const bashTool = createBashTool(workdir, aclPolicy);
// AclPolicy.checkPath() runs before every file operation inside the subprocess
```

### Tool library — two tiers

Tools are organised into two tiers:

```
Tier A — Standard tools (agent-runtime-worker)     selectable per-agent via disabledTools[]
├── Always on:  Bash, WriteFile, EditFile
│               PostMessage, ListMessages, ReadMessage, ListTeam, mental_map_*
│               FetchUrl, AnalyzeMemories
├── Optional:   Research, InspectImage, BrowseWeb, SearchWeb
└── Conditional: SearchWeb (needs BRAVE_SEARCH_API_KEY), BrowseWeb (needs Chromium)

Tier B — Elevated tools (control-plane, copilot only)   injected via additionalTools
└── ListMissions, GetMissionStatus, ReadMissionMailbox, ReadMissionLog, ReadMissionFile,
    ListSchedule, ListTemplates, GetTemplate, ProposeAction
```

`runAgent` builds the full Tier A list, filters it by `agent.disabledTools`, then appends
`AgentRunContext.additionalTools` (Tier B). Tier B tools are never filtered by `disabledTools`.

### Tier A tool inventory

Every tool name is case-sensitive and can appear in `disabledTools` in the agent YAML.

| Tool name | Category | Notes | Conditional on |
|-----------|----------|-------|----------------|
| `Bash` | Shell | Command execution via `sudo -u <linuxUser>`; `AclPolicy.checkPath` validates paths | — |
| `WriteFile` | Shell | Full file write; path validated before subprocess spawn | — |
| `EditFile` | Shell | Surgical `old_string → new_string` replacement | — |
| `PostMessage` | Coordination | Send a message to one or more agents or to `"user"` | — |
| `ListMessages` | Coordination | List inbox headers | — |
| `ReadMessage` | Coordination | Read a message body and mark as read | — |
| `ListTeam` | Coordination | List all agents: id, name, role, supervisor | — |
| `mental_map_update` / `mental_map_add` / `mental_map_remove` | Coordination | Surgical HTML patch of the agent's Mental Map by element ID | — |
| `FetchUrl` | Web/data | HTTP GET → HTML (Readability) or PDF; auto-describes images via vision LLM | — |
| `InspectImage` | Web/data | On-demand detailed analysis of an image in workdir via vision LLM | — |
| `SearchWeb` | Web/data | Brave Search API → ranked result list | `BRAVE_SEARCH_API_KEY` |
| `BrowseWeb` | Web/data | Stagehand/Playwright JS-rendered browsing; SSRF blocked | Chromium present |
| `Research` | Agentic | Nested `runInnerLoop` in isolated context; writes results to `sharedDir/research/` | — |
| `AnalyzeMemories` | Memory | Searches full conversation history (incl. compacted/pruned turns) in MongoDB; recovers stubbed tool outputs | — |
| `AddTask` / `UpdateTask` | Objectives | Create or update a task in the mission's objectives store (ADR-0019); updates are limited to the task's assignee, creator, objective owner, or the operator/mission copilot | — |
| `RecordKpi` | Objectives | Record a value for a KPI the agent owns | — |
| `Allocate` | Objectives | Explicit cost-allocation timesheet across tasks/objectives, used only when the mental map flags unattributed cost | — |

### Per-agent tool configuration

Agents opt out of specific Tier A tools via `disabledTools` in the team YAML — the same
pattern as `disabledSkills`:

```yaml
agents:
  - id: report-writer
    disabledTools:
      - Research     # writer agent doesn't need the expensive nested research loop
      - BrowseWeb    # no browser needed for formatting/writing tasks
```

Tool names must match the table above exactly (case-sensitive). Omitting `disabledTools`
gives the agent the full Tier A set (minus tools blocked by missing env/Chromium).

### Per-agent limits (Sprint 24)

Agents carry an optional `limits` block evaluated against the `StatsCollector`'s in-memory
turn/lifetime accumulators (no DB query in the hot path). Two severities:

- **Hard** (`max*`) — **opt-in, no default**. A breach throws out of the inner-loop hook and
  aborts the turn immediately (recorded as `status: 'aborted'`); useful work already done in
  the turn is preserved. Never applied unless explicitly configured, so an existing mission's
  legitimate long turn is never cut off by surprise.
- **Soft** (`warn*`) — **advisory, defaulted**. A breach routes a `limit-alert` to the copilot
  mailbox and the monitor dashboard (deduped per rule per turn) without interrupting the turn.
  Conservative built-in defaults (`warnLlmCallsPerTurn: 40`, `warnPeakContextTokens: 160000`,
  `warnToolErrorsPerTurn: 8`, `warnConsecutiveZeroOutputTurns: 3`) fire only on genuinely
  anomalous turns; set a field to `0` to disable that default.

```yaml
agents:
  - id: records-officer
    limits:
      maxLlmCallsPerTurn: 60       # hard: abort a runaway turn
      maxCostPerTurnUsd: 0.80      # hard: per-turn cost cap
      maxLifetimeCostUsd: 25       # hard: per-agent lifetime cost cap (trips mid-turn)
      warnLlmCallsPerTurn: 25      # soft: override the default (40) warning threshold
```

Hard limits complement the existing between-turn mission cost cap (`MAX_COST_USD` →
`waitForBudget`): the per-turn caps catch a single runaway *during* the turn, the mission cap
gates the next dispatch. The copilot assesses soft alerts and decides whether to intervene.

The mission-wide cap can also be set as `mission.maxCostUsd` in team config, which takes
precedence over the `MAX_COST_USD` env var and — unlike the env var, re-derived fresh from the
execution-plane machine's env at every boot — survives a suspend/resume cycle. The mission
copilot's own limits live in a separate top-level `missionCopilotLimits` field (same shape as any
agent's `limits`), since the copilot is daemon-injected and has no `agents[]` entry to carry a
`limits` key. The cockpit's **Limits** tab reads and edits all of this — mission cap, every
agent's hard/soft limits (including the copilot's) against live consumption — via
`GET`/`PATCH /api/missions/:id/limits*` on the control plane; edits to per-agent limits (like any
team-config change) apply on the mission's next resume, not immediately, while a mission-cap edit
also applies live via the running mission's `/set-budget`.

### Tier B elevated tools (copilot only)

Tier B tools require infrastructure only available in the control plane (MongoDB `db` handle,
Fly Machines API, SSE push channel). They are constructed by `copilot-daemon.ts` and injected
into `AgentRunContext.additionalTools`. They are never available to execution-plane agents and
cannot be disabled via `disabledTools`. (The mission-copilot has its own Tier B set on the
execution plane — see below.)

| Tool name | Purpose |
|-----------|---------|
| `ListMissions` | List all missions with their current status. |
| `GetMissionStatus` | Get full status of a mission including live Fly machine state. |
| `ReadMissionMailbox` | Read recent messages from any mission's mailbox. |
| `ReadMissionLog` | Read the daemon log for a running mission from its monitor server. |
| `ReadMissionFile` | Browse or read files in a mission's sharedDir or an agent's workdir. |
| `ReviewObjectives` | Read a mission's objective tree with current task status, KPI values, and budget-vs-spend. |
| `AssessKpi` | Record a value for a KPI you assess (a copilot-assessment KPI). |
| `SaveObjectiveTree` | Replace a mission's objective tree (definitions + KPI definitions — not task/KPI status, which agents update themselves during the mission). |
| `EditDraftConfig` | Directly edit a draft mission's config — mission-level fields and agents (add, update, or remove). |
| `ListSchedule` | List scheduled messages, optionally filtered by mission. |
| `ListTemplates` | List available mission team config templates. |
| `GetTemplate` | Get the full config and associated files for a team config template. |
| `ProposeAction` | Propose a mutating action for operator confirmation. |
| `ListIssues` | List or search open GitHub Issues in the MAGI repository. |
| `CreateIssue` | Propose a new GitHub Issue in the MAGI repository for operator confirmation. |
| `CloseIssue` | Propose closing a GitHub Issue (optionally with a closing comment) for operator confirmation. |
| `AddIssueComment` | Propose a comment on an existing GitHub Issue for operator confirmation. |

**Mission-copilot Tier B tools.** On the execution plane the mission-copilot alone (matched on the
literal agent id `mission-copilot`, never on config data) is given extra tools from
`mission-copilot-tools.ts` through the same `additionalTools` mechanism: config, objectives,
transcripts, budget, scheduling, background-job control and the GitHub proxy (ADR-0016). It also gets
`RequestResourceUpgrade` and `EndResourceUpgrade` (ADR-0031, `resource-upgrade-tool.ts`): request a
temporary bigger machine (CPU kind, CPUs, RAM, mandatory duration ≤ 60 min) or return to the default.
The control plane performs the resize; worker agents cannot call these tools and instead ask the
mission-copilot by mailbox message (the `request-resources` skill).

The mission-copilot's full set, in the order `createMissionCopilotTools` builds it (a contract test
keeps this table and the code in step):

| Tool name | Purpose |
|-----------|---------|
| `ReadMissionConfig` | Read this mission's current team configuration — mission name/model, every agent's role/system prompt/skills — and its attached team files. |
| `SaveMissionConfig` | Patch this mission's structured team configuration. |
| `ReadMissionObjectives` | Read the mission's full objective tree — every objective, owner, status, KPIs with current values, budget vs. spend. |
| `EditObjectiveTree` | Replace the mission's objective tree (definitions + KPI definitions — not task/KPI status, which agents update themselves via AddTask/UpdateTask/RecordKpi). |
| `ReadAgentMentalMap` | Read a teammate's current mental map — what it believes it's doing right now. |
| `ListAgentSessions` | List a teammate's session/turn history with summary stats (cost, call count, duration) per turn. |
| `ReadAgentUsage` | Lightweight per-call summary for one agent — model, token counts and cost for 90 days; tool names for the last day. |
| `ReadAgentSessionDetail` | Full transcript for one turn — every message, tool call, and timing. |
| `ReadAgentLlmCall` | Full detail for one specific LLM call — system prompt, complete input messages, complete response. |
| `ReadMissionMailboxAll` | Read the mission's mailbox across every agent — and every message to/from the user — not just messages addressed to you. |
| `ReadMissionInteractions` | Message-count matrix between every pair of agents in the mission — a shape-of-coordination overview before drilling into ReadMissionMailboxAll. |
| `SearchMissionHistory` | Keyword search across every agent's conversation history in this mission (not just one agent's, unlike the standard AnalyzeMemories tool) — returns matching excerpts, not full messages. |
| `ReadMissionCostSeries` | Per-turn cost series for the mission, optionally filtered to one agent — the same data backing the cockpit's Trace chart. |
| `ReadMissionLifetimeStats` | Lifetime cost/call/turn totals per agent. |
| `SetMissionSpendCap` | Set the mission-wide hard spending cap — pauses the entire mission if exceeded (distinct from an objective's own budgetUsd, which is soft/informational and edited directly in goals.json). |
| `PauseAgent` | Halt a teammate at its next dispatch boundary. |
| `ResumeAgent` | Lift a previous pause. |
| `CreateScheduledMessage` | Schedule a one-off or recurring wakeup message to one or more teammates. |
| `CancelScheduledMessage` | Cancel a pending scheduled message. |
| `CancelBackgroundJob` | Kill a running background job (a run-background-skill job, distinct from the scheduled messages above). |
| `RestartBackgroundJob` | Re-submit a failed or cancelled job's original spec as a new job. |
| `ReadMissionLog` | Tail the daemon's own log output. |
| `ReadFileHistory` | Git provenance for a sharedDir file — which agent/turn/commit last touched it. |
| `ReadSharedFile` | Read any file (or list a directory) under the mission's shared workspace. |
| `ReadAgentWorkdirFile` | Read any file (or list a directory) under one teammate's private workspace. |
| `ListBackgroundJobs` | Structured status of async background jobs (jobs/pending\|running\|status) — a convenience over browsing sharedDir/jobs/ by hand. |
| `ListScheduledMessages` | List this mission's pending scheduled wakeups. |
| `ListGithubIssues` | Search open issues in the MAGI_V3 repo — call before filing, to avoid duplicates. |
| `ReportGithubIssue` | Propose a new GitHub issue for a genuine platform bug (not a mission-content problem). |
| `RequestResourceUpgrade` | Request a temporary upgrade to a bigger machine (CPU kind, CPUs, RAM) for a genuine compute burst. |
| `EndResourceUpgrade` | Return the mission to its default machine now, before the upgrade window ends. |

**Resource oversight (ADR-0032).** `AnomalyCategory` (`anomaly.ts`) has ten values: the six
original ones (`limit-breach`, `agent-crash`, `agent-timeout`, `llm-error`, `job-failure`,
`scheduling-failure`, `unclean-restart`) plus `disk-usage-high` (daemon sampler, soft 80%/hard
90% of the Fly Volume), `spend-cap-near`/`spend-spike` (control-plane resource-monitor tick, from
`missionStats`/`agentTurnStats`), `upgrade-cap-near`/`upgrade-cap-reached`/`upgrade-idle`
(ADR-0031 machine-upgrade dataset), `resize-failure` (a failed upgrade resize), `oom-suspected`
(a Fly machine exit consistent with an OOM kill, `fly-events.ts`), and `resume-failure` (a plain
`resume_mission`/`POST /:id/resume` failing for any reason — most commonly a drifted
`mission.volumeId`, see issue #62). Every category except `atlas-storage-high` goes through the
shared `AnomalyRecorder`: persisted to `missionAnomalies`, notified to the mission's own copilot
at any severity, relayed to `copilot-{userId}` only when hard. `atlas-storage-high` (shared
MongoDB Atlas cluster storage, soft 70%/hard 85% of `ATLAS_STORAGE_LIMIT_MB`) has no owning
mission, so it posts directly to each `PLATFORM_ADMIN_USER_IDS` recipient's copilot mailbox
instead.

**Mission-volume-drift recovery (issue #62).** In addition to the read-only `GetMissionStatus`
line above, `ProposeAction` accepts `fix_mission_volume: { missionId }`: the server (never the
LLM) searches Fly's own volume list for the one matching the mission's existing naming convention
(`flyVolumeName()`), excluding volumes already claimed by another non-destroyed mission, and
refuses rather than guessing on an ambiguous or empty match. It writes only `mission.volumeId` in
MongoDB — it never touches Fly. `resume_mission` itself also detects when the mission's machine no
longer exists (as it wouldn't after a resume that failed this way) and falls back to
reprovisioning fresh against the volume, rather than only supporting the ordinary
suspend-then-resume case. See `config/teams/copilot/skills/mission-recovery/SKILL.md`'s failure
mode #8 for the full recovery sequence.

A control-plane copilot with a running mission also receives a **daily resource report**
(`resource-report.ts`) once `RESOURCE_REPORT_HOUR_UTC` (default 12 UTC) has passed for the day:
per-mission spend, machine tier and upgrade time, disk usage, and — for platform admins — the
Atlas breakdown, plus a computed FLAGS list (disk/spend/upgrade-cap thresholds, growth-rate
projections, a "chronic upgrade" pattern, and stale/missing resource samples). Four new
control-plane-copilot team skills (`config/teams/copilot/skills/`) handle these:
`daily-resource-report`, `disk-pressure`, `atlas-storage`, `vm-upgrade-oversight`; `cost-management`
and `mission-recovery` (same directory) and the platform `incident-triage` skill were extended
with sections for the new categories.

**Background jobs** (via Tool IPC server at `:4001`, not registered as LLM tools):

Agents submit long-running work via the `run-background` skill (`magi-job` CLI), which calls the
Tool IPC server. The server dispatches to Research, SearchWeb, FetchUrl, Bash, or BrowseWeb and
writes results to `sharedDir/jobs/`. Recurring work goes through files: the `schedule-task`
skill (`schedule.sh`, a message) and the `run-background` skill (`schedule-job.sh`, a job) write
`sharedDir/schedules/<label>.json`; the daemon imports each file within a minute into
`scheduled_messages`, attributed to the file's owner (ADR-0033 §3, `schedule-ingest.ts`); the
control plane keeps the clock, waking the mission's machine on each fire and either mailing the
message or stamping the document for the daemon to run the job.

### ACL enforcement

All file paths are validated by `AclPolicy.checkPath(path, "read"|"write")` before any filesystem
operation. The policy is derived from the agent's `AgentIdentity` (workdir, sharedDir) — agents
can read/write their private workdir and the shared mission folder; cross-agent private paths are
denied. OS-level `setfacl` ACLs provide a second enforcement layer at the subprocess level.

---

## 7. Agent Identity Model

Each agent has a resolved identity at runtime:

```typescript
interface AgentIdentity {
  workdir: string;    // $AGENT_WORKDIR/home/{linuxUser}/missions/{missionId}/
  sharedDir: string;  // $AGENT_WORKDIR/missions/{missionId}/shared/
  linuxUser: string;  // OS user this agent's tools execute as (via sudo)
}
```

`linuxUser` comes from the team YAML (`linuxUser` field, optional; defaults to `agent.id` in
production Docker). In dev, pre-existing pool users `magi-w1..magi-w5` are assigned. In
production, dedicated OS users are created per-agent at machine startup.

**ACL enforcement:**
1. **Application layer**: `AclPolicy.checkPath()` runs inside every tool factory before any
   filesystem call — validates the path is within the agent's permitted directories.
2. **OS layer**: `setfacl` rules set by `WorkspaceManager.provision()` enforce the same policy
   at the filesystem level, providing defence-in-depth for subprocess tool calls.

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

Priority (`normal` / `high`) is advisory — the orchestration loop does not interrupt a running agent turn but processes high-priority messages first in the next cycle.

### MongoDB implementation

Messages are stored as documents in the `mailbox` collection, scoped by `mission_id`. The daemon watches for new documents via a **Change Stream** (`collection.watch()` with `operationType: "insert"` filter); when a new message arrives the Change Stream cursor fires and the orchestration loop wakes immediately.

For role-based delivery (`recipient.role`), the sender looks up all agents in the team config with the matching role and inserts one document per agent.

**Scheduled messages** are stored separately in `scheduled_messages` with a `deliverAt` timestamp. The control plane's `node-cron` heartbeat (runs every minute) queries for `deliverAt ≤ now` documents, inserts them into `mailbox`, and marks them `status: "delivered"`. This fires the Change Stream and wakes the daemon.

Message durability relies on MongoDB write concern; the Change Stream cursor reconnects with exponential backoff on network errors.

---

## 9. Artifact System

Artifacts are directories written to the agent's workdir or sharedDir by `FetchUrl`, `BrowseWeb`,
or directly by the agent via Bash/WriteFile:

```
artifacts/{artifact-id}/
  content.md     # extracted text (Readability/mupdf + inline vision descriptions)
  meta.json      # provenance sidecar: url, dateCreated, encodingFormat, images[]
  image-0.jpg    # images extracted from article body (if any)
  image-1.png
```

Artifact IDs are human-readable and sortable: `{slugified-hostname}-{YYYYMMDD}T{HHmmss}` for
fetched URLs, `{slugified-filename}-{timestamp}` for user uploads.

Cross-agent sharing: all fetched content written to `sharedDir/artifacts/` is visible to all
agents on the mission. Agents discover artifacts via Bash (`ls`, `cat meta.json`).

Provenance metadata in `meta.json` is mandatory. Every artifact traces back to its source URL
and the timestamp it was fetched.

---

## 10. Workspace Model

### Directory layout

All paths are rooted at `$AGENT_WORKDIR` (default: cwd in dev; `/missions` on Fly Volume in production):

```
$AGENT_WORKDIR/
  home/{linuxUser}/missions/{missionId}/       ← agent's private workdir
    artifacts/                                 fetched documents + extracted images
    uploads/                                   user-uploaded files

  missions/{missionId}/shared/                 ← shared mission folder (all agents)
    artifacts/                                 shared published artifacts
    research/                                  research index (written by Research tool)
    briefs/                                    published reports
    skills/
      _platform/                               platform skills (read-only, copied at provision)
      _team/                                   team-specific skills
      mission/                                 mission-created skills (agent-authored)
    jobs/
      pending/   running/   status/            background job state
    data-factory/                              data factory outputs (catalog, prices, news)
    (git repo)                                 entire sharedDir is a git repository
```

### Provisioning

`WorkspaceManager.provision(agents, missionId)` is called once at daemon startup:
1. Creates `sharedDir` and each agent's private `workdir`.
2. Copies platform and team skill files from `packages/skills/` into `sharedDir/skills/`.
3. Runs `git init` in `sharedDir` (the `git-provenance` skill teaches agents the commit convention).
4. Runs `setfacl` to grant each agent's `linuxUser` read/write access to `sharedDir` and read/write
   access to their own `workdir` only.

---

## 11. Configuration

All team configuration is in YAML files validated against the Zod schema in `packages/agent-config/`.

### Team config format (`config/teams/{name}.yaml`)

```yaml
mission:
  id: equity-research
  name: "Equity Research Team"
  timezone: America/New_York  # optional IANA name; adds a local-time line to every
                               # agent's current-time block (prompt.ts) — UTC/Unix/
                               # day-of-week are always shown regardless

agents:
  - id: lead-analyst
    name: "Alexandra"
    role: lead-analyst
    supervisor: user          # escalation target; "user" = operator
    linuxUser: magi-w1        # optional; defaults to agent id in production Docker
    systemPrompt: |
      You are Alexandra, the lead-analyst of the Equity Research Team.
      ...
      ## Your mental map
      {{mentalMap}}
      ...
    initialMentalMap: |       # seed HTML injected on first session
      <section id="mission-context"><p>...</p></section>
      <section id="tasks"><ol></ol></section>
      <section id="working-notes"><p></p></section>

  - id: data-scientist
    name: "Marcus"
    role: data-scientist
    supervisor: lead-analyst
    linuxUser: magi-w2
    systemPrompt: |
      ...
    initialMentalMap: |
      ...

schedules:
  - agent: lead-analyst
    cron: "30 5 * * 1-5"     # 5:30 AM weekdays UTC
    subject: "Daily Session"
    body: "Run the daily gold market brief."
```

The Zod schema validates required fields (`id`, `supervisor`, `systemPrompt`, `initialMentalMap`)
and rejects configs with duplicate agent IDs or unknown supervisor references.

---

## 12. Testing Strategy

### Three tiers

**Unit tests** (`npm test`) — pure, deterministic logic only; no LLM calls, no network:

| What | Approach |
|------|---------|
| Zod config validation | Invalid YAML variants; assert exact error messages |
| ACL policy evaluation | `(linuxUser, path, operation)` → allow/deny |
| `mental_map_*` HTML patching | Assert DOM state after each operation |
| `patchMentalMap` idempotency | Same patch applied twice → same result |
| SSRF regex | Known-private hosts and Fly WireGuard ranges |
| Cost computation | `computeCost(usage, model)` for cache/non-cache variants |

**Integration tests** (`npm run test:integration`) — real LLM calls with deterministic-outcome
prompts; real MongoDB Atlas; real pool users; full stack:

- Each test creates a unique `missionId` via `randomUUID()`
- `afterEach` cleans up with `deleteMany({ missionId })` on all collections
- Prompts are chosen so the LLM outcome is deterministic (e.g., "count the words in this file;
  the answer is 12" → assert reply contains "12")
- Tests cover: multi-agent word count, skills discovery, reflection, data factory, background jobs,
  browse-web, fetch/inspect, search-web, tool API

**Evaluation tests** (`eval/`) — run on demand with real LLMs; assert structural/policy outcomes
over multiple runs; not in CI. See `eval/` directory.

Do not write tests for prompt wording, LLM tool selection choices, or report content quality.

---

## 13. Observability

**LLM call log** (`llmCallLog` MongoDB collection): every `runInnerLoop` call records model, token
counts (input, output, cache read, cache write), cost, agentId, missionId, turnNumber, and whether
it was a reflection call. Query with `npm run cli:usage`.

Retention policy: full entries (system prompt, message array, model response) are kept for 7 days.
After 7 days the control-plane daily cron at 02:00 UTC runs `$unset` on `input` and `output`,
preserving usage/cost metadata indefinitely for billing reconciliation. The `input` and `output`
fields on `LlmCallLogEntry` are typed `optional` in TypeScript to reflect this post-pruning state.

**SSE dashboard** (monitor server, port 4000): real-time mission state streamed to the browser.
Sections: mission feed (all mailbox messages), agent tabs (sessions tree, mental map iframe, LLM
call detail), queue strip (current running agent), budget pause banner, usage bar with spending cap.
Accessible via the control plane proxy at `/missions/{missionId}/dashboard`.

**Daemon log** (`$AGENT_WORKDIR/daemon.log`): daemon stdout/stderr tee'd to this file at startup.
Accessible in the browser via `GET /missions/{missionId}/log` → "View Log" button in the UI.

**No OpenTelemetry** in the current implementation. Full distributed tracing is a planned
future capability (Sprint 20+).

---

## 14. External Dependencies and References

- **`@mariozechner/pi-ai`** — `completeSimple(model, context)` is the non-streaming LLM call
  used by `runInnerLoop` and `runReflection`. `getModel("openrouter", id)` provides OpenRouter
  model descriptors. This is the only direct runtime dependency on pi-mono.
- **MAGI v2** — Mental Map design (§4), image handling strategy (§5), and the mental-map editing tools
  semantics are adapted from v2's `Editor` tool and vision pipeline.

For full details on these projects, see [docs/references.md](docs/references.md).
