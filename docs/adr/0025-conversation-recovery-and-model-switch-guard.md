# ADR-0025 — Conversation-recovery bugs found via a live copilot incident, and a model-switch guard

**Status**: Accepted
**Sprint**: 27 (pulled forward — live production incident)
**Date**: 2026-07-31

---

## Context

The operator switched the control-plane copilot's model from Claude Sonnet to Kimi K3, hit an
immediate error, switched back to Sonnet, got a different error ("incorrect tool calls"), switched
back to Kimi, got a third error. Every subsequent turn failed identically regardless of model.

Traced via real Fly logs and the actual stored `conversationMessages` (read-only investigation
first, per this project's standing "ask before running DB-writing scripts" discipline):

**Trigger.** The copilot was mid-turn, building a large `ProposeAction` tool call
(`save_session_config`), when the model was switched. `POST /api/copilot/settings`
(`copilot-router.ts`) called `runningDaemons.get(userId)?.stop()` — an `AbortController.abort()`,
fire-and-forget — then immediately deleted the daemon handle. The very next `/message` call started
a fresh daemon on the new model while the old one's `runAgent()` call was still asynchronously
unwinding. `loop.ts`'s `runInnerLoop` persisted the partial assistant message (containing the
`ProposeAction` tool call) via `pushAndNotify` before checking `stopReason`, and broke the loop
immediately after — the tool never ran, so its result was never saved. That left a permanent
dangling `tool_use` (turn 38, id `toolu_017bPA9pDMSSxYnZNWHkBXf6`) in the copilot's history.

**Why every retry re-hit the same failure, regardless of model.** This codebase already has a
self-healing mechanism for exactly this shape of corruption:

- `convertToLlm()` (`reflection.ts`) detects an orphaned `tool_use` and injects a synthetic "this
  was interrupted" `tool_result` on every read.
- `agent-runner.ts`'s `runAgent()` detects a structural replay error
  (`isConversationStructureError`) and calls `forceCompactSession()` to discard the corrupted
  history behind a recovery summary, then retries once.

Neither fired. Two independent, previously-undetected bugs, both in shared code used by every
agent, not copilot-specific:

1. **Wrong message selected.** The structural-error check searched `result.messages` (`[
   ...previousMessages, task, ...this session's new messages]`) with `.find()` for the first
   assistant message — which, for any agent with real prior history, is an ancient, successful
   message from long ago, not the one that just failed. `isConversationStructureError()` returned
   `false` immediately (its first line: `if (msg.stopReason !== "error") return false;`) and
   recovery never fired, for any agent with substantial history, not just the copilot.
2. **The recovery's own summary was self-destructing.** `forceCompactSession(nextTurnNumber, ...)`
   wrote its recovery summary at `turnNumber: nextTurnNumber - 1`, then compacted everything with
   `turnNumber < nextTurnNumber + 1`. Since `nextTurnNumber - 1` is always `< nextTurnNumber + 1`,
   the summary was marked compacted the instant it was written — `load()` would have returned
   nothing at all, not "just the recovery summary" as the function's own doc comment promised. This
   bug was latent and untriggered until bug 1 was fixed, since recovery had never actually run.

Different providers surfaced the same underlying corruption differently — Anthropic's stricter
tool_use/tool_result block-adjacency validation (`"messages.182.content.1: unexpected tool_use_id
found in tool_result blocks..."`) vs. Kimi's own validation (`"Kimi K3 tool messages need a
resolvable tool name..."`) — which is why switching models appeared to produce a new problem each
time, rather than obviously the same one.

## Decision

### Code fixes (shared, benefit every agent, not just the copilot)

1. **`agent-runner.ts`**: the structural-error check now reuses `lastMsg` (already computed as
   `result.messages.at(-1)`) instead of searching from the front. `turnCount === 1` already
   guarantees nothing could follow the erroring message, so the last message in the array is always
   the right one — no new array traversal needed.
2. **`agent-runner.ts`**: `forceCompactSession()`'s summary now lands at `nextTurnNumber + 1` (the
   compact boundary itself), not `nextTurnNumber - 1`. `compact(keepFrom)` marks `turnNumber <
   keepFrom` compacted, so a summary written *at* `keepFrom` survives; one written before it never
   could.
3. **`loop.ts`** (the actual root cause, not just its downstream symptom): when a turn ends via
   `stopReason === "error"` or `"aborted"`, any `toolCall` blocks in the final assistant message —
   parsed from the stream but never executed — now get matching synthetic `toolResult` messages
   persisted immediately, before the loop breaks. History is self-consistent from the moment it's
   written, for *any* cause of abort (model switch, timeout, operator cancel, daemon shutdown), not
   just this one incident's trigger. `convertToLlm`'s read-time patch remains as a backstop for
   older/pre-existing corruption, not the primary mechanism.

### Guard against recurrence: reject, don't race

`copilot-daemon.ts`'s `CopilotDaemonHandle` gained `isBusy()`, backed by a plain ref flag set around
the `runAgent()` call. `copilot-router.ts`'s `POST /settings` checks it first and returns `409` with
a clear message ("Copilot is currently running a turn — wait for it to finish before changing the
model") instead of aborting mid-flight. The legacy dashboard (`index.html`) now surfaces the real
error text from a failed settings save instead of a generic "Failed to update" toast — the original
vague failure is exactly what led to blind retrying into the same error three times.

Considered and rejected: making the switch *wait* for the current turn to finish instead of
rejecting. A copilot turn can run for minutes; blocking the HTTP request that long is worse UX than
an immediate, actionable rejection, and matches how the operator was already retrying by hand.

## Consequences

- **Fixes 1 and 3 apply to every agent**, not just the copilot — the same class of corruption (a
  turn cut short with an in-flight tool call) is possible from `MAX_AGENT_RUN_SECONDS` timeouts,
  operator-initiated stops, or daemon restarts, not only a copilot model switch.
- **Fix 3 is the actual root-cause fix**; fixes 1–2 make the existing safety net work as designed
  for whatever corruption still slips through (e.g. anything written before this deploy, or by a
  cause fix 3 doesn't cover).
- **Data recovery**: ran the now-corrected `forceCompactSession` against the live copilot's history
  directly (`agentId: "copilot"`, `missionId: "copilot-{uid}"`, `nextTurnNumber: 41` — the turn
  active during the last failed retry). Verified before/after: 203 non-compacted messages → 1 (the
  recovery summary), confirming the boundary fix holds against real data, not just the unit test's
  synthetic fixture.
- **Verified**: new unit tests for `isConversationStructureError` (including the verbatim error
  text from the live incident), `forceCompactSession`'s boundary (regression test that would have
  caught bug 2 directly), and `loop.ts`'s synthetic-result-on-abort behavior (both explicit abort
  and mid-stream provider error). Full unit suite green (326 passing; 3 pre-existing, unrelated
  timing-sensitive failures under this session's elevated system load — a PDF-processing timeout and
  a hardcoded wall-clock concurrency assertion in `orchestrator.ts`, neither touched by this change).
  Integration suite run against real LLM calls to confirm no regression on the main turn loop.
- **Not covered**: the busy-guard only protects the one route this incident went through
  (`/api/copilot/settings`). No equivalent guard exists yet for other operator actions that might
  interrupt an in-flight turn (there don't currently appear to be any, but worth checking if new
  ones are added).

## Related

- `packages/agent-runtime-worker/src/agent-runner.ts` — `isConversationStructureError`,
  `forceCompactSession` (both now exported for testability)
- `packages/agent-runtime-worker/src/loop.ts` — abort/error tool-call cleanup
- `packages/control-plane/src/copilot-daemon.ts` — `isBusy()`
- `packages/control-plane/src/copilot-router.ts` — `/settings` busy guard
- `packages/agent-runtime-worker/tests/agent-runner.unit.test.ts`,
  `tests/loop-abort-cleanup.unit.test.ts`
