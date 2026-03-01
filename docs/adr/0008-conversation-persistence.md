# ADR-0008: Conversation Persistence

## Status

Accepted (designed 2026-03; implementation planned for Sprint 6)

## Context

The MAGI v3 inner loop (`runInnerLoop`) currently starts with an empty message history on
every `runAgent()` call. The LLM context for each agent turn is:

```
[system prompt — role + mental map + skills list]
[user turn — formatted mailbox messages for this wakeup only]
```

This is a divergence from the design intent. MAGI v2 persisted the full conversation history
(user messages, assistant responses, tool calls, tool results) to MongoDB and reloaded it on
every request, so each LLM call had access to the complete history of reasoning. The original
intent for MAGI v3 was the same model: each agent maintains a continuous, growing conversation
across all its wakeups within a mission.

Two reference implementations were studied to inform this design.

### MAGI v2 approach (`MAG_v2/backend/src/services/messageContext.ts`)

- History stored as a message array in a `conversations` MongoDB collection; one document per
  conversation.
- Loaded **once** before the agent loop; not re-queried between tool calls. Tool call / result
  pairs produced during the loop are pushed onto the in-memory array.
- `filterMainAgentMessages()` applied before the first LLM call:
  - Sub-agent internals (source `'websearch'`, `'research-query'`, etc.) are excluded from the
    main agent — only the Research tool invocation and its final result are visible.
  - High-volume tool results (Editor diffs, Fetch content) are scoped to the **current turn
    only** to avoid token waste; RAGSearch and Critique results are kept across all turns.
- `rollbackId` field enables soft-delete of rolled-back turns without physical deletion.
- Each message carries a `turnNumber` (incremented only by user messages) — the compaction
  anchor and rollback boundary.
- System prompt is **static per conversation** (loaded from a template once, never rebuilt).
  The mental map is a *separate* parameter passed alongside it.
- Raw LLM call inputs/outputs stored in a separate `llmCallList` array for explainability
  (the "Explain" feature) — independent from the conversation messages stream.

### pi-agent-core approach (`pi-mono/packages/agent/src/`)

- **In-memory only** — no persistence. The `Agent` instance owns `state.messages: AgentMessage[]`.
- Custom message types via TypeScript declaration merging: apps add roles such as `"notification"`
  or `"artifact"` which are stored in `state.messages` but **filtered by `convertToLlm()`**
  before any LLM call. By default only `user`, `assistant`, `toolResult` messages reach the LLM.
- `transformContext(messages, signal)` — pluggable compaction hook called before every LLM call.
  The caller provides the algorithm; the library provides the hook.
- System prompt is a **separate field** (`AgentState.systemPrompt`), never inserted into the
  messages array. `setSystemPrompt(v)` allows updating it between turns.

## Decision

Persist the full conversation history per `(agentId, missionId)`. The conversation **resets per
mission** — it does not survive across missions.

### StoredMessage and ConversationRepository

Each `Message` produced by `runInnerLoop` is stored with a `turnNumber` annotation:

```typescript
// src/conversation-repository.ts

export interface StoredMessage {
  /** Incremented each time runAgent() is called for this agent × mission. */
  turnNumber: number;
  /** Verbatim pi-ai message: UserMessage | AssistantMessage | ToolResultMessage. */
  message: Message;
}

export interface ConversationRepository {
  /** Load all messages for this agent on this mission, oldest first. */
  load(agentId: string, missionId: string): Promise<StoredMessage[]>;
  /** Append messages produced in the current turn. */
  append(agentId: string, missionId: string, messages: StoredMessage[]): Promise<void>;
  /** Discard all messages with turnNumber < keepFrom (compaction cut point). */
  trim(agentId: string, missionId: string, keepFrom: number): Promise<void>;
}
```

`createMongoConversationRepository()` is the only implementation. There is no in-memory
variant — MongoDB is required for all integration tests. Tests clean up via
`deleteMany({ missionId })` in `afterEach`.

### MongoDB schema

Separate documents per message (not one large array document). `trim()` becomes a simple
`deleteMany`; documents stay small; indices are efficient.

```
collection: conversationMessages

{
  agentId:    string,
  missionId:  string,
  turnNumber: number,
  seqInTurn:  number,    // ordering within one turn (0-based)
  message:    Message,   // serialised pi-ai Message
  savedAt:    Date
}

compound index: { agentId: 1, missionId: 1, turnNumber: 1, seqInTurn: 1 }
```

### convertToLlm — the LLM boundary filter

Following pi-agent-core's pattern, a `convertToLlm()` function is applied when loading
stored messages before passing them to the LLM. Initial implementation is a pass-through;
this is the correct place for future compaction logic.

```typescript
function convertToLlm(stored: StoredMessage[]): Message[] {
  return stored.map((s) => s.message);
  // Future: truncate old large Bash/Fetch tool results, drop turns before compaction cut,
  // apply v2-style current-turn scoping for high-volume tools.
}
```

### System prompt handling

In MAGI v3 the system prompt is rebuilt on every `runAgent()` call because the mental map
evolves between wakeups. The Anthropic API accepts `system` as a separate parameter distinct
from the `messages` array, so the current system prompt is always passed fresh — it is never
inserted into the stored message history. This means:

- The LLM always sees the up-to-date mental map even when replaying old turns.
- The message history contains only `user` / `assistant` / `toolResult` messages.
- No historical messages need to be updated when the system prompt changes.

This differs from MAGI v2's static system prompt. The MAGI v3 approach is strictly better for
mental map freshness.

### How new mailbox messages enter the conversation

Each time `runAgent()` is called for an agent:

1. Load `StoredMessage[]` from the repository.
2. Apply `convertToLlm()` → `previousMessages: Message[]`.
3. Build a new user turn from the current inbox: `formatMessages(messages)` → `task: string`.
4. Call `runInnerLoop({ ..., previousMessages, task })`. The loop prepends history before
   the new user turn:
   ```
   [...previousMessages, { role: "user", content: task }]
   ```
5. `runInnerLoop` returns the new `Message[]` produced this turn.
6. `append(agentId, missionId, newMessages)` with the current `turnNumber`.

### Changes to runInnerLoop

`InnerLoopConfig` gains `previousMessages?: Message[]` and the function returns `Message[]`
(the new messages produced this turn, ready for appending to the repository). No other
callers or semantics change.

## Compaction (deferred to Sprint 9+)

Compaction strategy is deferred. The design provides four hooks for it:

| Hook | Mechanism |
|------|-----------|
| `turnNumber` | `trim(agentId, missionId, keepFrom)` — `deleteMany` on the DB; no message scanning |
| `convertToLlm` | Token budget enforcement and truncation of old large tool results |
| **Mental map** | The natural compaction artifact: agents maintain it across turns; dropped turns do not lose key facts as long as the mental map was kept current |
| **Summarisation** | Extra LLM call to summarise the oldest N turns into a replacement user message before trimming |

The combination of mental map + summarisation is the target compaction strategy. Research into
best-practice algorithms (sliding window vs. importance sampling vs. hierarchical summary) is
deferred to Sprint 9.

## Comparison

| Concern | MAGI v2 | pi-agent-core | MAGI v3 |
|---------|---------|---------------|---------|
| History storage | MongoDB array in `conversations` doc | In-memory `Agent.messages` | MongoDB, separate docs per message |
| LLM boundary filter | `filterMainAgentMessages()` before loop | `convertToLlm()` per LLM call | `convertToLlm()` before loop |
| Compaction | None | `transformContext` hook | `trim()` + `convertToLlm` + mental map (deferred) |
| System prompt | Static (loaded from template once) | Separate param, mutable | Rebuilt every turn, separate param |
| Turn scoping | `turnNumber` on each message | Not built-in | `turnNumber` on `StoredMessage` |
| Rollback | `rollbackId` soft-delete | Not built-in | Out of scope (add when needed) |
| Custom message types | `source` + `toolName` fields | Declaration merging | Not needed yet |

## Consequences

| File | Change |
|------|--------|
| `src/conversation-repository.ts` | **New** — `StoredMessage`, `ConversationRepository`, `createMongoConversationRepository` |
| `src/loop.ts` | `InnerLoopConfig` gains `previousMessages?: Message[]`; function returns `Message[]` |
| `src/agent-runner.ts` | `AgentRunContext` gains `conversationRepo: ConversationRepository`; `runAgent` loads history before loop and appends new messages after |
| `src/orchestrator.ts` | Passes `conversationRepo` in `agentCtx` |
| `src/cli.ts` | Instantiates `ConversationRepository` and `MentalMapRepository` from MongoDB (`MONGODB_URI` required); removes all in-memory repo instantiation. `InMemoryMailboxRepository` and `InMemoryMentalMapRepository` deleted from their respective modules. |
| `src/mental-map.ts` | No change — `createMongoMentalMapRepository` already exists |

The `trim()` and `convertToLlm` hooks are present from day one. The compaction algorithm is
a future concern and does not block the implementation.
