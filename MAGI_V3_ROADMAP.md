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

## Sprint 3 — Durability: Temporal and Redis Mailbox ← NEXT

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
