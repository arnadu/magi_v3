# ADR-0009: Context Management — Session-Boundary Compaction and Reflection

## Status

Accepted and implemented (Sprint 9). See § Divergence from original design for changes
made during implementation.

## Context

ADR-0008 introduced conversation persistence and deferred compaction to "Sprint 9+". This
ADR closes that deferral. The problem has three dimensions:

### 1. Unbounded context growth

Each session appends messages to MongoDB; the full history is reloaded at every wakeup.
An equity research agent running daily will accumulate:

- ~500–2 000 tokens per mailbox message
- ~5 000–50 000 tokens per session (FetchUrl/BrowseWeb extractions dominate)
- After 30 days: 150 k–1.5 M tokens per agent — approaching or exceeding the 1M-token
  context window of Claude Sonnet 4.6.

### 2. Context rot

Anthropic documents "context rot": as the context window fills, model accuracy degrades
before the hard limit is reached (transformer attention is O(n²); long-range dependencies
become noisy). Quality degrades noticeably beyond ~50–100 k tokens of real agent
conversation. A full 1M window is not twice as usable as a 500 k window.

### 3. Noise from bulky tool results

`FetchUrl`, `BrowseWeb`, and `Bash` can return 5–20 k tokens per call. Once an agent has
reasoned from a result, the raw body is noise. The agent's *reasoning* about the result
(in its assistant message) is what matters across sessions.

### Reference: MAGI v2 filtering pattern (`messageContext.ts`)

MAGI v2 used per-tool, per-turn filtering (`filterMainAgentMessages`) applied at every
HTTP request:

```
User / Assistant:              keep all turns
Editor tool results:           current turn only  (old HTML diffs waste tokens)
High-volume tools (Fetch,
  WebSearch, InspectImage):    current turn only
RAGSearch / Critique:          keep all turns     (persistent reasoning context)
Sub-agent internals:           excluded — only invocation + final result visible
```

This kept the context window bounded within a conversation, but the conversation was
unbounded across days (no cross-session compaction). MAGI v3 must handle a persistent
multi-session agent lifetime that v2 never had.

---

## Terminology

**Session** = one wakeup-to-sleep cycle. A session begins when `runAgent()` is called
(triggered by an inbox message) and ends when `runInnerLoop` returns. A mission consists
of many sessions per agent, one per wakeup.

**Reflection** = a consolidation step that runs at the *start* of every session (except
the first). It consolidates the *previous* session's raw messages into an updated Mental
Map and a cumulative narrative summary before the agent's inner loop begins.

**Compaction** = marking MongoDB documents as `compacted: true` so they are excluded from
`load()` (prompt preparation) while being retained for audit and future RAG retrieval.
Documents are never deleted.

---

## Decision

### Session-boundary compaction

The compaction unit is the **session**: every session's raw messages are compacted at the
start of the next session. This is the simplest model that bounds context growth — no
per-tool rules, no turn-count thresholds within a session.

Within a session the agent has full fidelity: every message including large tool-result
bodies is passed to the LLM unchanged. This is intentional — the agent may need to
reference a fetch result multiple times within the same task. Across sessions, only the
summary and the updated Mental Map survive.

### Algorithm: what happens on each wakeup

```
runAgent(agentId, inboxMessages, ctx)

  1.  load()  →  history
      ─────────────────────────────────────────────────────────────────────
      Returns all non-compacted, non-reflection StoredMessages, oldest first.
      On the very first wakeup: []
      On subsequent wakeups:    prior summaries + last session's raw messages

  2.  Reflect (conditional — see threshold below)
      ─────────────────────────────────────────────────────────────────────
      sessionMessages = history where role ≠ "summary"
      previousSummaries = history where role = "summary"

      Skip reflection if:
        • sessionMessages is empty (first wakeup), OR
        • peakInputTokens < REFLECTION_CTX_THRESHOLD (120 000 tokens)
          where peakInputTokens = usage.input of the last AssistantMessage
          in sessionMessages. The last call has the largest input because it
          accumulated the full session context. Sessions where even the peak
          call stayed under 60 % of the 200 k window are too cheap to justify
          a separate reflection call.

      runReflection(sessionMessages, previousSummaries, lastTurnNumber)
        a. Build prompt:
              PRIOR SESSION SUMMARIES  ← previousSummaries joined (extend, not repeat)
              CURRENT MENTAL MAP       ← current HTML from mentalMapRepo
              SESSION TRANSCRIPT       ← sessionMessages serialised, tool bodies
                                         truncated to 2 000 chars

        b. Run mini inner loop with UpdateMentalMap as the only tool.
              The reflection LLM calls UpdateMentalMap 0-N times to patch
              changed sections. Only elements with an id attribute are
              addressable — static sections (no id) are inherently protected.
              Reflection messages persisted with isReflection:true.

        c. Extract summary from the reflection LLM's final text response.

        d. append(summary at turnNumber = lastTurnNumber + 1)
              ← saved BEFORE compact. Crash between d and e is safe:
                old messages remain (redundant, not lost).

        e. compact(keepFrom = lastTurnNumber + 1)
              ← marks all turnNumber < lastTurnNumber+1 as compacted:true.
                This includes: old session's raw messages AND any prior
                summaries (their content is now in the new cumulative summary).

      reload history  →  [new summary only]

  3.  convertToLlm(history)
      ─────────────────────────────────────────────────────────────────────
      Simple transform — no per-tool filtering:
        role:"summary"                → user message "[Session history summary]\n…"
        role:"user"|"assistant"|      → pass through unchanged
              "toolResult"

  4.  Build system prompt
      ─────────────────────────────────────────────────────────────────────
      systemPrompt = agent role + Mental Map HTML (now updated by reflection)
                   + skills block

  5.  runInnerLoop(previousMessages, task, tools, onMessage)
      ─────────────────────────────────────────────────────────────────────
      Each message persisted to MongoDB immediately via onMessage as it
      arrives (not batched at end). The agent sees:

        [system]   role + updated Mental Map + skills
        [user]     "[Session history summary]\n<cumulative narrative>"   ← 0 or 1
        [user]     formatted inbox messages                              ← new task
        [assistant → tool → assistant → …]                               ← this session
```

### What the LLM sees at the start of session N (N > 1)

```
SYSTEM PROMPT
  ┌──────────────────────────────────────────────────────┐
  │  role description                                    │
  │  <mental-map>                                        │
  │    <!-- static: operator-set, no id -->              │
  │    <section id="finding-list">                       │
  │      <!-- updated by reflection from sessions 1..N-1 │
  │    </section>                                        │
  │    …                                                 │
  │  </mental-map>                                       │
  │  skills block                                        │
  └──────────────────────────────────────────────────────┘

MESSAGES
  [user]  "[Session history summary]
           Session 1: fetched article on NVDA earnings; found revenue +12% YoY;
           posted finding to lead. Session 2: lead asked for sector comparison;
           fetched semiconductor index data; found NVDA outperforming peers by 8%;
           posted comparison table."

  [user]  "From lead-analyst (2026-03-25): Please update your thesis for Q2."
```

No raw tool results from previous sessions. No turn-number-based filtering within the
current session. Two memory stores work together:
- **Mental Map** — structured, patchable, visible in every system prompt
- **Summary** — narrative, cumulative, injected as the opening user message

### Cumulative summaries

Each reflection receives all prior summaries as input and is instructed to extend them
(not replace them). The resulting summary incorporates everything from sessions 1..N-1 in
a single narrative. When reflection compacts, it compacts the old summaries too — they are
no longer needed as the new summary subsumes them.

This means there is always exactly one summary in `load()` after the first reflection.

### Mental Map editing: static and editable zones

The Mental Map HTML distinguishes two zones:

- **Static zones** (no `id` attribute): operator-set constants the agent can read but not
  modify. `UpdateMentalMap` requires an `id` to address any element; elements without one
  are inherently protected.
- **Editable zones** (`id` attribute): agent-writable during a session (via `UpdateMentalMap`)
  and patched by reflection between sessions.

Both the agent and the reflection LLM use the same `UpdateMentalMap` tool. No separate
patch-parsing mechanism is needed — the tool's existing ID validation and HTML sanitisation
apply equally to both callers.

### MongoDB document schema

```typescript
interface ConversationDoc {
  agentId:      string
  missionId:    string
  turnNumber:   number      // session index (0, 1, 2, …)
  seqInTurn:    number      // position within the turn (0, 1, 2, …)
  message:      Message | SummaryMessage
  savedAt:      Date
  compacted?:   boolean     // set by compact(); excluded from load()
  isReflection?: boolean    // set for reflection inner-loop messages; excluded from load()
}
```

Unique index on `(agentId, missionId, turnNumber, seqInTurn)` — enforces exactly one
document per position. `seqInTurn` is computed by `countDocuments` before each insert;
correctness relies on append never being called concurrently for the same
`(agentId, missionId, turnNumber)` (serialised by the inner loop).

### Crash safety

Summary is saved (step 2d) before compaction (step 2e). If the process crashes between
the two:
- Old messages remain uncompacted → they appear in `load()` on the next wakeup
- Reflection retries on the same session on the next wakeup
- The orphaned reflection messages from the failed attempt remain at `turnNumber =
  lastTurnNumber + 1` but are excluded from `load()` via `isReflection: true`
- `UpdateMentalMap` uses replace semantics → idempotent on retry

No MongoDB transactions are needed.

---

## Divergence from original design

The implementation differs from the draft in several ways:

| Original design | Actual implementation |
|---|---|
| Reflect at session **end** | Reflect at session **start** (next wakeup) — agent sees updated Mental Map and summary from the first message of the new session |
| `<patch id="…">` XML output parsed by `parseReflection()` | Reflection LLM calls `UpdateMentalMap` tool directly — same tool as the agent; no custom output format |
| `KEEP_FULL_TURNS = 2` keeps last 2 turns verbatim, collapses older HIGH_VOLUME_TOOLS results | Entire previous session compacted — no per-tool retention rules |
| `trim()` deletes MongoDB documents | `compact()` marks `compacted: true` — documents retained for audit/RAG |
| Mid-session reflection at 80k token threshold | Session-end gate implemented: reflection only runs when the last LLM call's input tokens ≥ 60 % of CTX_LIMIT (120 000 / 200 000). Mid-session trigger (fire during `runInnerLoop` without waiting for session end) deferred to Sprint 10. |
| `AnalyzeMemories` tool (MongoDB text search) | Index scaffolded; tool deferred to Sprint 10 |

---

## Files

| File | Role |
|------|------|
| `src/reflection.ts` | `convertToLlm`, `serializeForReflection`, `buildReflectionSystemPrompt`, `runReflection` |
| `src/agent-runner.ts` | Wires reflection before `runInnerLoop`; persists reflection messages with `isReflection:true` |
| `src/conversation-repository.ts` | `StoredMessage`, `SummaryMessage`, `compact()`, `load()` filter, unique index |
| `tests/reflection.integration.test.ts` | Two-session test: session 1 fetches large URL; session 2 recalls finding from summary without re-fetching. 5 assertions. |
| `config/teams/reflection-test.yaml` | Single-agent team with structured Mental Map for integration test |

---

## Consequences

| | Outcome |
|-|---------|
| Context budget | Bounded per session: system prompt (~5 k) + one cumulative summary (~1 k) + current session messages. A 30-day equity research agent stays well under 50 k tokens per wakeup. |
| Reflection cost | Gated by the 60 % threshold: only sessions that built significant context trigger a reflection call. Trivial sessions (brief acknowledgments, short ping-pong exchanges) are skipped. Reflection LLM calls are tracked by `UsageAccumulator` and surfaced in the dashboard via the `llm-call` SSE event — previously they were invisible (a `ReflectionContext.onMessage` hook threads them through the same pipeline as regular agent messages). |
| Information loss | Possible — reflection is lossy. Mitigated by: Mental Map preserves structured facts; `AnalyzeMemories` (Sprint 10) provides recovery path via MongoDB text search over compacted history |
| Audit trail | All raw messages retained in MongoDB with `compacted:true`; reflection inner-loop messages retained with `isReflection:true`. Full history queryable for debugging and future RAG. |
| Crash safety | Summary saved before compact — no transactions needed; worst case is a redundant retry |
| Idempotency | Compaction is idempotent (`updateMany` with `$set`); `UpdateMentalMap` uses replace semantics; reflection can safely retry on the same session |

## Comparison with prior art

| | MAGI v2 | MAGI v3 (this ADR) |
|-|---------|--------------------|
| Filtering unit | Per-tool, per-turn (`filterMainAgentMessages`) | Per-session (entire session compacted) |
| Within-session fidelity | High-volume tools dropped after current turn | Full fidelity — all messages passed unchanged |
| Cross-session memory | None — history grows unboundedly | Summary (narrative) + Mental Map (structured) |
| Mental Map update | Agent only, during loop | Agent during loop + reflection LLM between sessions |
| Tool results in context | Current-turn only for Fetch/WebSearch/InspectImage | Not visible across sessions; full body within session |
| Storage | In-memory only (stateless HTTP) | MongoDB — `compacted` flag preserves raw history |
