# ADR-0009: Context Management — Tool-Result Scoping, Reflection, and Long-Term Memory

## Status

Accepted (designed 2026-03; implementation planned for Sprint 9)

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
(in its assistant message) is what matters across sessions. MAGI v2 addressed this with
`filterMainAgentMessages()` — current-turn scoping for high-volume tools.

### Reference: MAGI v2 filtering pattern (`messageContext.ts`)

```
User / Assistant messages: keep all turns
Editor tool results:        current turn only
High-volume tools (Fetch,
  WebSearch, InspectImage): current turn only
RAGSearch / Critique:       keep all turns (persistent reasoning context)
Sub-agent internals:        excluded — only invocation + final result visible
```

The MAGI v3 equivalent must handle: `FetchUrl`, `BrowseWeb`, `Bash`, `SearchWeb`,
`InspectImage` → current + recent turns only. `PostMessage` and `ListMessages` →
always kept (small, carry inter-agent provenance).

---

## Terminology

**Session** = one wakeup-to-sleep cycle. A session begins when `runAgent()` is called
and ends when `runInnerLoop` returns. A mission consists of many sessions per agent.

**Reflection** = a post-processing step that runs at the end of a session (and optionally
mid-session when a token threshold is crossed). It consolidates the session's conversation
into an updated Mental Map and a narrative summary that replaces old turns in the stored
history. Reflection is implemented as a separate LLM call with a dedicated system prompt;
it is not part of the agent's own inner loop.

---

## Decisions

### 1. Tool-result scoping in `convertToLlm`

`convertToLlm()` — currently a pass-through in `agent-runner.ts` — is upgraded to a
context filter that runs once per wakeup, before `runInnerLoop`.

**Rules:**

| Tool | Retention |
|------|-----------|
| `PostMessage`, `ListMessages`, `ReadMessage`, `ListTeam` | Always kept — small, carry inter-agent provenance |
| `UpdateMentalMap` | Always kept — small; agent needs to see its own map updates |
| `FetchUrl`, `BrowseWeb`, `Bash`, `SearchWeb`, `InspectImage` | Full body for turns `>= currentTurnNumber - KEEP_FULL_TURNS` (default 2); collapsed to one-line placeholder for older turns |

**Placeholder format:**
```
[FetchUrl result — processed in turn 3, session 2026-03-10T06:00Z]
```

**Implementation:**

```typescript
const KEEP_FULL_TURNS = 2

const HIGH_VOLUME_TOOLS = new Set([
  'FetchUrl', 'BrowseWeb', 'Bash', 'SearchWeb', 'InspectImage'
])

function convertToLlm(stored: StoredMessage[], currentTurnNumber: number): Message[] {
  return stored.flatMap((sm) => {
    const m = sm.message
    if (m.role === 'user' || m.role === 'assistant') return [m]

    if (m.role === 'toolResult') {
      const isOld = sm.turnNumber < currentTurnNumber - KEEP_FULL_TURNS
      if (isOld && HIGH_VOLUME_TOOLS.has(m.toolName ?? '')) {
        // Collapse body — preserve toolCallId so the LLM call/result chain stays valid
        return [{
          ...m,
          content: [{
            type: 'text',
            text: `[${m.toolName} result — processed in turn ${sm.turnNumber}]`
          }]
        }]
      }
      return [m]
    }

    // Summary messages (role: 'summary') → prepend as user message
    if ((m as { role: string }).role === 'summary') {
      return [{ role: 'user', content: `[Session history summary]\n${(m as { content: string }).content}` }]
    }

    return [m]
  })
}
```

### 2. Reflection: post-session and mid-session

A **reflection** consolidates a session's conversation into:
1. Mental Map patches (via `UpdateMentalMap`-compatible `<patch id="...">` blocks)
2. A narrative summary (300–500 words) that replaces old turns in the next session

**Trigger conditions:**

- **Session end** (always): runs after `runInnerLoop` returns in `runAgent()`, regardless
  of context size.
- **Mid-session** (threshold): when the estimated token count of in-session messages
  exceeds `MID_SESSION_THRESHOLD` (default 80 000 tokens), reflection fires between inner
  loop turns. The session continues with the compacted context.

**Token estimation heuristic:** `chars / 4` (conservative; overestimates). Applied to
`JSON.stringify(message)` for each stored message.

**Placement:**

```
// agent-runner.ts

const newMessages = await runInnerLoop({ ..., transformContext })
                                                    ↑
// transformContext hook (inside the loop) handles mid-session threshold:
// if estimate > threshold → call runReflection() → replace session history with summary

// After runInnerLoop returns:
await runReflection(agentId, missionId, newMessages, ctx)  // session-end reflection
await ctx.conversationRepo.append(agentId, missionId, newMessages, turnNumber)
```

**Reflection system prompt (kept in `src/reflection.ts`):**

```
You are a reflective summarizer for an AI research agent. You are NOT the agent and must
NOT continue any task or conversation. Your job is to consolidate what happened in a
session into two outputs:

1. Mental Map patches — for each section that changed, output:
   <patch id="element-id">updated content (HTML fragment)</patch>
   Only output patches for sections that actually changed. Never patch read-only sections
   (those without an id attribute).

2. A narrative summary of this session — wrap in <summary>...</summary>.
   Include: what the agent was asked to do, what it found, what decisions it made,
   what it sent to other agents, and what comes next.
   Aim for 300–500 words. Be specific: include numbers, tickers, sources, and file paths
   where relevant. This summary will replace the raw session history for future wakeups.
```

**Reflection output parsing:**

```typescript
interface ReflectionResult {
  patches: Array<{ id: string; content: string }>
  summary: string
}

function parseReflection(text: string): ReflectionResult {
  const patches = [...text.matchAll(/<patch id="([^"]+)">([\s\S]*?)<\/patch>/g)]
    .map(m => ({ id: m[1], content: m[2].trim() }))
  const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/)
  return {
    patches,
    summary: summaryMatch?.[1].trim() ?? ''
  }
}
```

### 3. Summary storage and turn trimming

After reflection:

1. Save the narrative summary as a `StoredMessage` with `role: 'summary'` and
   `turnNumber = currentTurnNumber` (or the mid-session turn at which it was generated).
2. Call `conversationRepo.trim(agentId, missionId, keepFrom)` where `keepFrom` is the
   oldest turn to keep verbatim (default: `currentTurnNumber - KEEP_FULL_TURNS`).

The `conversationMessages` MongoDB collection gains a text index on
`message.content` / `message.text` fields to support the future `AnalyzeMemories` tool
(see § 5 below). No behavioural change in Sprint 9; the index is scaffolding.

**Reconstructed context at next wakeup:**

```
[system prompt: role + Mental Map (updated by reflection) + skills]
[summary message: "[Session history summary]\n<narrative>"]   ← turns 0..N-3
[turn N-2: full messages, tool results included]
[turn N-1: full messages, tool results included]
[new user turn: formatted mailbox messages]
```

### 4. Structured Mental Map: static and editable zones

Formalises the pattern from MAGI v2:

- **Static zone** (no `id` attribute): operator-set constants the agent reads but cannot
  modify. Includes mission parameters and `class="instructions"` guidance paragraphs.
- **Editable zone** (`id` attribute): agent-writable fields, patchable by `UpdateMentalMap`
  during a session and by `runReflection()` at session end.
- **`class="instructions"`**: in-situ guidance visible in every wakeup's system prompt.
  Tells the agent what to record in each section and when. Not patchable (no `id`).

**Standard section IDs (equity research team):**

| id | Owner | Content |
|----|-------|---------|
| `recommendation` | Agent + Reflection | Current L/S/neutral, one sentence |
| `confidence` | Agent + Reflection | 0–1 score |
| `thesis` | Agent + Reflection | One-paragraph investment thesis |
| `finding-list` | Agent + Reflection | `<li>` items: fact + source + date |
| `infra-list` | Agent + Reflection | `<li>` items: scripts, data files, providers |
| `task-list` | Agent + Reflection | `<li>` items: pending work with agent assignee |
| `pending-list` | Agent + Reflection | `<li>` items: outstanding inter-agent requests |

The `finding-list` and `task-list` sections include a `class="instructions"` guideline
specifying the maximum number of items before older ones should be pruned.

### 5. `AnalyzeMemories` tool (scaffolded in Sprint 9, implemented in Sprint 10)

Sprint 9 adds the MongoDB text index on `conversationMessages`. Sprint 10 adds the tool:

```
AnalyzeMemories(
  question: string,
  scope?: 'own' | 'team',   // default: 'own'
  max_results?: number       // default: 5
) → { answer: string, sources: Array<{agentId, turnNumber, excerpt}> }
```

Implementation: MongoDB text search → top-N excerpt retrieval → sub-`completeSimple`
call with retrieved passages → synthesized answer. No vector database required for the
initial version.

---

## Files

| File | Change |
|------|--------|
| `src/reflection.ts` | **New** — `runReflection(agentId, missionId, sessionMessages, ctx)`, prompts, `parseReflection()`, `serializeForReflection()` |
| `src/agent-runner.ts` | Wire `convertToLlm` filter; call `runReflection()` after `runInnerLoop`; add mid-session `transformContext` hook |
| `src/conversation-repository.ts` | Add `saveSummary()` method; add MongoDB text index |
| `src/loop.ts` | `transformContext` hook receives token estimate; reflection injection on threshold |
| `config/teams/equity-research.yaml` | Structured `initialMentalMap` per agent with static/editable zones and `instructions` guidance |
| `tests/reflection.unit.test.ts` | **New** — parse output, token estimation, `convertToLlm` filter rules |
| `tests/reflection.integration.test.ts` | **New** — see ADR § Integration Test |

---

## Integration Test

The integration test for Sprint 9 validates the full reflection + compaction cycle:

**Setup:**
- Single agent (word-count team config, or a new minimal `reflection-test` team)
- Seed a workdir with two test documents

**Session 1:**
1. Wakeup with task: "Fetch [local URL serving ~3 000 words of text], extract the word
   count, and record your finding."
2. Agent calls `FetchUrl` → large result body.
3. Agent reports finding to user via `PostMessage`.
4. Session ends → reflection fires.

**Assertions after session 1:**
- `conversationMessages` collection contains a `role: 'summary'` document for this agent.
- `conversationMessages` no longer contains the raw `FetchUrl` tool result (trimmed).
- The agent's Mental Map `finding-list` section contains a `<li>` with the word count.
- Reflection cost logged (one extra `llm-call` event in the monitor or usage accumulator).

**Session 2:**
1. Wakeup with task: "What did you find in your last research session? Give me the
   specific number."
2. Agent has access to: updated Mental Map (with finding) + summary + last 2 turns.
   The raw `FetchUrl` body is gone.

**Assertions after session 2:**
- Agent's reply to user contains the correct word count.
- Agent did NOT re-fetch the URL (no `FetchUrl` tool call in session 2).
- Total tokens in session 2 context < total tokens in session 1 context (compaction worked).

This test validates: tool-result scoping, reflection execution, summary storage,
Mental Map patching, and effective context compaction — in one coherent scenario.

---

## Consequences

| | Outcome |
|-|---------|
| Context budget | Bounded per session: ~2 k (system) + ~3 k (Mental Map) + ~500 (summary) + ~10–20 k (last 2 turns) = well under 30 k tokens per wakeup on day 15+ |
| Reflection cost | One additional LLM call per session end (~$0.01–0.05 at Sonnet 4.6 prices for a typical equity research session) |
| Information loss | Possible: reflection is lossy. Mitigated by: Mental Map preserves key facts; `AnalyzeMemories` tool (Sprint 10) provides recovery path for specific past details |
| Daemon restart safety | Reflection saves to MongoDB before trimming; crash between reflection and trim is safe (next session has more history than ideal but loses nothing) |
| Existing tests | No breakage: `convertToLlm` defaults to pass-through if `currentTurnNumber` is 0 or undefined; reflection is skipped if session produces zero messages |

## Comparison with prior art

| | MAGI v2 | pi-mono coding-agent | MAGI v3 (this ADR) |
|-|---------|---------------------|-------------------|
| Tool scoping | Per-call filter (`filterMainAgentMessages`) | `transformContext` hook | `convertToLlm` once per wakeup |
| Summary generation | None | Dedicated compaction call | `runReflection()` at session end |
| Mental Map update | Agent-only (during loop) | N/A (no Mental Map) | Agent during loop + reflection at end |
| Trigger | N/A | Token threshold | Session end (always) + token threshold (mid-session) |
| Storage | In-memory only | Session file | MongoDB (`role: 'summary'` document) |
