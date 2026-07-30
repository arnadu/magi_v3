# ADR-0024 — OpenRouter cache efficiency: session affinity + static system prompt

**Status**: Accepted
**Sprint**: 26c
**Date**: 2026-07-30

---

## Context

A follow-up to ADR-0023 (the pi-ai fork/patch for OpenRouter's real cost): with `providerCost`
wired into `llmCallLog`, real spend became visible for the first time — and it showed a real
problem. A read-only query against `llmCallLog` for the live `gold-digest-v2` mission (24h window,
`z-ai/glm-5.2` via OpenRouter) found **16 of 58 calls (27.6%) were full cache misses**, costing
~$0.84 versus a hypothetical ~$0.16 if cached — **~$0.68/day wasted, ~43% of this one mission's
entire daily LLM spend**.

Checking miss timing against MAGI's 5-minute timestamp-rounding bucket (`prompt.ts`'s
`TIME_ROUND_MS`, the mitigation issue #24 had already flagged for Anthropic's cache): only 1 of 16
misses aligned with a bucket crossing. The rest happened mid-turn, between consecutive calls with a
stable, growing conversation — e.g. one agent hit cache, then missed 33 seconds later with no
plausible content change in between. That pattern points at **OpenRouter routing inconsistency**,
not MAGI's own prompt instability, as the dominant real-world cause.

Investigation (reading `pi-ai`'s `openai-completions.js` directly, cross-checked against
OpenRouter's own caching docs) found two independent, compounding gaps:

1. MAGI never sent OpenRouter's own sticky-routing guarantee (`session_id` / `x-session-id`) —
   pi-ai supports it but defaults `compat.sendSessionAffinityHeaders` to `false` for every
   provider, and MAGI never passed `options.sessionId` either. Without it, OpenRouter falls back to
   a best-effort hash of "opening messages" to decide which backend replica to route to — which the
   data suggests fails often enough to matter.
2. `buildSystemPrompt()` (`prompt.ts`) rebuilt fresh on every LLM call, with the agent's mental map
   substituted inline and the 5-minute-rounded time block appended — both legitimately changing
   within a session. Any change invalidates pi-ai's automatic Anthropic-style `cache_control`
   breakpoint (and threatens OpenRouter's own hash-based routing key) for the *entire* block, not
   just the part that changed.

## Decision

### Fix 1 — explicit OpenRouter session affinity (primary, targets the dominant loss)

`models.ts` gained `withOpenRouterAffinity()`, applied at every OpenRouter model-construction site
(`DEEPSEEK_V3_2`, `MINISTRAL_14B`, both branches of `parseModel()`'s OpenRouter path): sets
`compat.sendSessionAffinityHeaders = true`. `loop.ts`'s `InnerLoopConfig` gained `sessionId?:
string`, threaded into `completeSimple()`'s `SimpleStreamOptions`. `agent-runner.ts` passes
`` `${missionId}:${agentId}` `` — stable for the agent's whole lifetime, matching OpenRouter's own
description of routing being tracked "per model, and per conversation," not just per turn.

Verified live, not just via unit test: temporarily instrumented the installed pi-ai package to log
outgoing headers, made one real OpenRouter call with this wiring, confirmed
`x-session-id: "test-mission:test-agent"` was actually sent and the call succeeded — then reverted
the instrumentation (not part of the committed change).

Scoped to the main turn loop only (`agent-runner.ts` → `loop.ts`'s `runInnerLoop`) — the path
carrying the real repeated, cacheable traffic. Reflection's own `runInnerLoop` call and the
Research/BrowseWeb sub-loops are untouched (lower volume, trivial to extend later).
Document-processor/InspectImage vision calls (`MINISTRAL_14B`) are excluded on purpose: OpenRouter's
docs don't list Mistral as supporting caching at all, and those calls are one-shot, not multi-turn,
so session affinity has no payoff there.

### Fix 2 — static system prompt (secondary, closes MAGI's own contribution)

`buildSystemPrompt()` is now fully static — no `mentalMapHtml` or `timezone` parameters, no
time-block call. The `{{mentalMap}}` placeholder every team YAML already uses (verified via grep
across `config/teams/*.yaml` — always the same position, end of the prompt) still gets substituted,
now with a static pointer sentence instead of live HTML, so **no YAML template needed to change**.

New `buildDynamicContextMessage(mentalMapHtml, timezone)` (same file) returns the current-time block
plus the live mental map as a single string. `loop.ts`'s `runInnerLoop` injects this as
`messages[0]` — never routed through `pushAndNotify`/`onMessage`, so it's never persisted to
`conversationMessages`, exactly like `systemPrompt` itself. Each inner-loop iteration recomputes it
and **replaces `messages[0]` in place only when the content actually changed** (not appended),
preserving the existing guarantee that an agent sees its own `mental_map_update` on the very next
call, while leaving the (much larger, cacheable) history byte-identical across iterations where
nothing changed — the common case.

`getDynamicContext` is optional on `InnerLoopConfig` specifically so the three other callers
(`reflection.ts`, `tools/research.ts`, `tools/browse-web.ts`) are unaffected.

**Deliberately not done in this pass**: giving the dynamic-context message its own 4th Anthropic
cache breakpoint via pi-ai's `onPayload` hook (Anthropic allows up to 4; pi-ai's automatic breakpoints
already use 3 — system prompt, last tool definition, last conversation message). Skipped because the
primary win (the much larger system-prompt block becoming stable and cacheable) doesn't need it, and
`onPayload` requires reasoning about each provider's converted wire-format shape — real added
fragility for a secondary gain. Worth a follow-up if warranted, not blocking here.

## Consequences

- **No YAML template changes.** `{{mentalMap}}` placeholder handling is unchanged syntactically;
  only what gets substituted there changed.
- **No persistence-path risk.** Verified while planning, not assumed: `LoopResult.messages` is only
  ever read via `.at(-1)`/`.find(isAssistantMessage)` in `agent-runner.ts`, never bulk-persisted or
  fed into the next session's `previousMessages` (that always comes fresh from
  `conversationRepo.load()`) — so the ephemeral dynamic-context message can never leak into stored
  history.
- **Cache-breakpoint math checked, not assumed**: the dynamic-context message at `messages[0]` could
  only collide with pi-ai's "last conversation message" breakpoint if it were the only message in
  the array — but the task message is always pushed before the first LLM call, so that breakpoint
  always lands on real conversation content.
- **Verified**: 321 unit tests (11 new — `prompt.unit.test.ts` for the static system prompt +
  `buildDynamicContextMessage`, new `loop-dynamic-context.unit.test.ts` for the pure
  replace-in-place mechanics, new `models.unit.test.ts` for `withOpenRouterAffinity`), 90
  integration tests (real Anthropic calls, unmodified — confirms Fix 2 doesn't regress the
  direct-Anthropic path), one live OpenRouter call confirming the `x-session-id` header.
- **Not yet verified**: the actual production miss-rate drop. The real proof is empirical — re-run
  the same read-only `llmCallLog` query used to establish the 16/58-misses baseline against a later
  window on `gold-digest-v2` once this is deployed.
- **Follow-up, not started**: extending `sessionId` to reflection/Research/BrowseWeb sub-loops if
  their own call volume turns out to matter; the 4th-cache-breakpoint enhancement noted above.

## Related

- [ADR-0023](0023-pi-ai-fork-openrouter-cost-patch.md) — the `providerCost` wiring that made this
  spend visible in the first place
- [GitHub issue #24](https://github.com/arnadu/magi_v3/issues/24) — prompt-cache efficiency, tracks
  both this ADR and the still-open 4th-breakpoint/sub-loop follow-ups
- `packages/agent-runtime-worker/src/models.ts` — `withOpenRouterAffinity`
- `packages/agent-runtime-worker/src/loop.ts` — `runInnerLoop`'s `sessionId`/`getDynamicContext`
- `packages/agent-runtime-worker/src/prompt.ts` — `buildSystemPrompt`, `buildDynamicContextMessage`
- `packages/agent-runtime-worker/src/agent-runner.ts` — call sites
