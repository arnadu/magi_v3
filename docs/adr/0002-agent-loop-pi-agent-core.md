# ADR-0002: Agent Loop Implementation — pi-agent-core

## Status
Accepted — partially superseded by Sprint 1 pragmatic simplification (see note below)

## Context

The inner agent loop (LLM call → tool execution → LLM call) is the core primitive that every
agent runs. It must handle:
- Streaming LLM responses
- Sequential tool dispatch with partial-result callbacks for UI updates
- Mid-run steering injection (critical alerts interrupting the inner loop)
- Follow-up messages after the agent would otherwise stop
- Abort signals for clean cancellation
- Context window management (token pruning, compaction)

Candidates evaluated:
1. **pi-agent-core `agentLoop()`** — from the companion pi-mono repository
2. **MAG_v2 `agentService.ts`** — MAGI V2's existing loop
3. **Custom implementation** — write from scratch

## Decision

Use **pi-agent-core's `agentLoop()`** as the inner loop implementation.

`agentLoop()` is actively maintained, handles streaming via `EventStream<AgentEvent>`, and
provides all required hooks (`getSteeringMessages`, `getFollowUpMessages`, abort signal) as
first-class configuration options. The `AgentMessage` type supports extension via declaration
merging, allowing MAGI V3 to add custom message types (`artifact`, `notification`) without
forking the library.

MAG_v2's `agentService.ts` was rejected because it is coupled to its Express/SSE transport
and MongoDB session model; decoupling it would require a near-rewrite.

Writing from scratch was rejected — pi-agent-core solves the hard streaming and tool
execution problems; reimplementing it adds risk with no architectural benefit.

## Consequences

- `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai` are direct dependencies of
  `agent-runtime-worker` (added in Sprint 1).
- Both packages are ESM-only; the workspace uses `"type": "module"` throughout.
- The outer loop is a separate LLM call sequence (planning prompt, constrained tools) written
  directly in MAGI V3; it is not a second `agentLoop()` instance.
- `convertToLlm` hook is the integration point for custom `AgentMessage` types.
- `getSteeringMessages` is the integration point for Temporal Signal → inner-loop interrupts.
- The inner loop terminates via `nextAction` structured output parsed from the final
  assistant message (tools disabled on the penultimate call to force the schema).

## Sprint 1 Note — Pragmatic Simplification

Sprint 1 built a custom `runInnerLoop` using `completeSimple` from `@mariozechner/pi-ai`
directly, rather than `pi-agent-core`'s `agentLoop()`.

**Why:** The full feature set of `pi-agent-core` (streaming, steering, follow-up messages,
context compaction) was not needed to prove the core loop. The simpler implementation
(`completeSimple` + sequential tool dispatch) is easier to understand and test, and matches
the loop's actual requirements at this stage.

**This ADR remains the target for production.** `pi-agent-core` adoption is planned when:
- Streaming to the frontend is required (Sprint 8)
- Mid-run steering injection is required (signals or abort; defer until Sprint 7's unattended-run requirement makes the pattern concrete)
- Context window compaction is required (whenever long sessions hit limits)

Until then, `runInnerLoop` in `packages/agent-runtime-worker/src/loop.ts` is the operative
inner loop implementation.
