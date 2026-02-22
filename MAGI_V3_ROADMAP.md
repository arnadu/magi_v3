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

## Sprint 2 — Multi-Agent Scaffolding, Outer Loop, and Mailbox

**Goal: multiple agents defined in a team config can communicate through a shared mailbox. Each agent runs an outer loop that reads its inbox, decides what to do next, dispatches its inner loop for execution, and sends replies. A supervisor chain lets any agent escalate to its supervisor; top-level agents escalate to the operator ("user").**

### Design

**Team config (YAML, loaded at mission startup):**

```yaml
mission:
  id: equity-research
  name: "Equity Research Team"
  agents:
    - id: lead-analyst
      name: "Alexandra"
      role: lead-analyst
      supervisor: user
      mission: >
        You are the Lead Analyst. You coordinate the research team, synthesise
        findings from your analysts, and produce the morning brief.
    - id: junior-analyst-1
      name: "Bob"
      role: junior-analyst
      supervisor: lead-analyst
      mission: >
        You are a Junior Analyst. You research and collect market data as
        directed by the Lead Analyst and report your findings back.
```

Each agent is given its own home directory (`workspaces/{agent-id}/`) as its working directory for file tools. Linux uid/gid enforcement is deferred to Sprint 4.

**MongoDB mailbox:**

One `mailbox` collection shared across all agents in a mission. Each message document:

```typescript
interface MailboxMessage {
  id: string;
  missionId: string;
  from: string;          // agent id or "user"
  to: string[];          // agent ids or ["user"]
  subject: string;
  body: string;
  timestamp: Date;
  readBy: string[];      // agent ids that have called ReadMessage on this
}
```

**Four mailbox tools** (available to the outer loop):

| Tool | Arguments | Returns |
|------|-----------|---------|
| `ListTeam` | — | All agents: `id`, `name`, `role`, `supervisor` |
| `ListMessages` | `since?`, `search?`, `limit?` | Inbox headers: `id`, `from`, `subject`, `timestamp` |
| `ReadMessage` | `id` | Full message body; marks as read for this agent |
| `PostMessage` | `to[]`, `subject`, `body` | Confirmation; `to` can include `"user"` for operator escalation |

`ListTeam` reads directly from the loaded team config — it is not a mailbox query.

**Supervisor chain:**

Every agent's system prompt includes its supervisor's id. When an agent is blocked or cannot proceed, it uses `PostMessage` to escalate to its supervisor. Top-level agents (supervisor = `"user"`) post to the operator inbox. The CLI (and later an API endpoint) polls `user`'s inbox and surfaces those messages.

**No `nextAction` structured output:**

The inner loop terminates naturally when the LLM stops calling tools (same as Sprint 1). No forced structured-output turn is needed: modern LLMs are robust enough to decide correctly when to stop, post a message, or escalate. The outer loop uses inbox state rather than a structured signal to determine what to do next.

**Outer loop scheduling — inbox-poll model:**

An agent runs when it has unread messages in its inbox. The outer loop terminates when no agent has unread messages. This replaces the `nextAction: waiting/done/escalate` mechanism entirely:

- **Initial run**: the orchestrator delivers the initial task by posting a message to the lead agent's inbox, which immediately makes it runnable.
- **Subsequent runs**: after each agent's inner loop exits, the outer loop checks every agent's inbox; any with unread messages are dispatched next.
- **Termination**: no agent has unread messages → mission turn complete.

Escalation to the supervisor is handled purely through `PostMessage`; the outer loop does not need to inspect a structured result to know this happened.

**Mental Map:**

MongoDB document per agent, HTML with stable section IDs:
- `#tasks` — prioritised task queue
- `#waiting-for` — tasks blocked on inbound replies, with the message id being awaited
- `#working-notes` — scratch space the agent manages itself
- `#mission-context` — injected at startup from the team config (role, mission, supervisor, teammates)

`UpdateMentalMap` tool: `replace`, `append`, `remove` operations targeting elements by id. Available to the outer loop only.

**Outer loop (`runOuterLoop`):**

Same LLM→tool→LLM pattern as `runInnerLoop` but with the planning prompt and constrained toolset (`ListTeam`, `ListMessages`, `ReadMessage`, `PostMessage`, `UpdateMentalMap`). Terminates when the LLM stops calling tools. After termination, if the agent's Mental Map `#tasks` section is non-empty, `runOuterLoop` calls `runInnerLoop` directly — the decision is internal and not visible to the orchestrator.

**Agent runner:**

`runAgent(agentId, signal)` is the only function the orchestrator calls. It owns the full outer→inner cycle and is fully opaque to the caller:

```
runAgent(agentId, signal):
  runOuterLoop(agentId, signal)     // read mail, update mental map
  if mentalMap.#tasks not empty:
    runInnerLoop(agentId, task, signal)   // execute
```

The orchestrator only knows: "run this agent; it will do the right thing." When Sprint 3 moves to Temporal/concurrent execution, `runAgent` becomes a Temporal Activity with no internal changes.

**CLI interaction model:**

The CLI runs an orchestration loop that is sequential but supports live user interaction:

- **Immediate output**: when any agent posts a message with `to` containing `"user"`, the `PostMessage` tool prints it to stdout immediately — before the current LLM turn returns.
- **Buffered input**: a `readline` listener runs concurrently with the loop. Any line the user types is buffered. At the start of each orchestration cycle, the buffer is drained and each line is posted as a message from `"user"` to the lead agent's inbox.
- **Step mode** (`--step` flag): after each `runAgent()` call, the loop pauses and prints a summary of what the agent did, then prompts `"Press Enter to continue, or type a message:"`. The user can inspect state before the next agent runs. Useful during development; omit for unattended operation.
- **Abort**: Ctrl+C triggers `AbortController.abort()`. The `AbortSignal` is threaded through `runAgent` → `runOuterLoop` → `runInnerLoop`; the current LLM turn completes cleanly and the loop exits.
- **Cycle guard**: a `maxCycles` limit (default 50) prevents runaway chains. If reached, the loop aborts with a warning.

### Deliverables

- `packages/agent-config` — YAML schema + TypeScript types + loader/validator for team configs
- `config/teams/equity-research.yaml` — reference team config
- `packages/agent-runtime-worker/src/mailbox.ts` — `MailboxRepository` (MongoDB) + the four mailbox tools
- `packages/agent-runtime-worker/src/mental-map.ts` — `MentalMapRepository` (MongoDB) + `UpdateMentalMap` tool
- `packages/agent-runtime-worker/src/outer-loop.ts` — `runOuterLoop(config)`
- `packages/agent-runtime-worker/src/agent-runner.ts` — `runAgent(agentId, teamConfig, missionContext)`
- Updated CLI: loads team config, provisions home dirs, starts N agents concurrently, polls "user" inbox and prints operator messages
- **Integration tests**:
  - *Single-agent*: extends the Sprint 1 file-editing test but wrapped in the full outer loop; confirms the outer loop scaffolding does not break the inner loop.
  - *Two-agent word count*: Lead + Worker team; one file (`greeting.txt`) contains "HELLO WORLD" plus additional words (total 11); Lead's task is "Find the file containing HELLO WORLD, pass its name to Worker, and report the word count"; Worker reads its inbox, runs `wc -w greeting.txt`, replies "11 words"; Lead reads the reply and reports the total. Assertion: Lead's final message contains "11". This covers YAML config loading, inbox-poll scheduling, both directions of mailbox exchange, and a deterministic verifiable result.

### Exit criteria

Two agents defined in a YAML config start up, communicate through the MongoDB mailbox, and complete the word-count task collaboratively. Lead's final message contains the correct word count ("11"). The outer loop terminates cleanly when no agent has unread messages. `npm run test:integration` passes end-to-end.

---

## Sprint 3 — Durability: Temporal and Redis Mailbox

**Goal: replace the Sprint 2 in-process orchestration and MongoDB mailbox with production-grade durability. Agent workflows survive worker crashes. Mailbox delivery is guaranteed even if the receiving agent's worker dies.**

Deliverables:
- Temporal workflow wrapping the agent runner: `AgentWorkflow` with outer-loop Activity and inner-loop Activity
- Temporal signals: `inbound_message`, `schedule_fire`, `critical_alert`, `abort`
- `mailbox-service`: drop-in replacement for the Sprint 2 MongoDB mailbox using Redis Streams; `mailbox:{agent_id}` streams with consumer groups; durable delivery with `XACK`. The four mailbox tools (`ListTeam`, `ListMessages`, `ReadMessage`, `PostMessage`) are unchanged — only the backend repository swaps.
- Critical interrupt path: `critical_alert` signal → `getSteeringMessages()` hook → clean abort of inner loop → requeue task in Mental Map
- Workflow survives worker crash and resumes without data loss (Temporal replay)
- **Integration tests**: Temporal crash recovery (kill worker mid-Activity, assert workflow resumes on correct task); Redis durable re-delivery after consumer death before `XACK`

Exit criteria: Agent workflow survives a simulated worker crash and resumes correctly. Two-agent task exchange works end-to-end with Redis mailbox and Temporal orchestration. All integration tests pass against real Redis and Temporal test server.

---

## Sprint 4 (2026-04-20 to 2026-05-01): Identity, Workspace, and ACL

**Goal: agents are isolated; they can only touch what their policy allows.**

Deliverables:
- `identity-access-service`: agent identity schema, uid/gid assignment, role-to-policy mapping
- `workspace-manager`: provisions `/home/agents/{agent_id}` and `/missions/{mission_id}/shared/{role}` with correct Linux ACLs (`setfacl`)
- Operations hooks in all file and bash tools enforce workspace policy; write to an unpermitted path fails with a clear policy-violation error (not a silent OS error)
- Tool registration filtered per role at agent instantiation — the agent never sees tools it cannot use
- Dev/prod workspace isolation: dev and prod paths are separate; publishing to prod from a dev agent is rejected at the tool level
- Team config YAML compiled to runtime `AgentIdentity` + tool list at mission startup
- `mission-api` stub: REST endpoint to start a mission from a team config file
- **Unit tests (TDD)**: ACL policy evaluation (pure function: given `(agent_id, path, action)` → `allow/deny`); tool registration filtering (given role policy, assert exact tool list)
- **Integration tests**: full `setfacl` workspace provisioning roundtrip; agent process running as its uid attempting write outside home dir — assert OS-level rejection matches policy-level rejection

Exit criteria: Agent attempting to write outside its allowed paths receives a policy denial (not an OS error). Two agents with different role policies demonstrate correct access separation on shared folders. Config validator catches an invalid policy at load time. Unit tests for ACL evaluation cover all policy combinations.

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
