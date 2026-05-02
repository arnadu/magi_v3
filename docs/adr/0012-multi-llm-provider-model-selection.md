# ADR-0012: Multi-LLM Provider and Model Selection

## Status

Accepted and implemented (Sprint 12).

## Context

The agent inner loop needs to call LLMs. MAGI V3 has two distinct call sites with
different requirements:

1. **Main inner loop** (`runInnerLoop`) — the agent's reasoning loop. Needs tool-use
   support, large context window, high quality. Cost-sensitive for long missions.
2. **Vision tasks** — image captioning at upload time (`FetchUrl`, `InspectImage`),
   page description in `BrowseWeb`. Needs image input support but quality requirements
   are lower; low per-call cost matters because vision calls happen on every image
   encountered.

The system must:
- Support Anthropic Claude (primary provider) and at least one alternative for cost
  optimisation
- Allow each call site to use a different model independently
- Not lock the LLM call layer to a single provider's SDK
- Read API keys from environment without manual wiring per provider

Additionally, equity-research data processing (background jobs, summarisation) could
benefit from cheaper non-Anthropic models, making provider flexibility a practical
near-term need rather than a hypothetical one.

### Candidates evaluated

| Approach | Description |
|----------|-------------|
| Direct Anthropic SDK (`@anthropic-ai/sdk`) | Single provider; easiest; no abstraction layer |
| `@mariozechner/pi-ai` `completeSimple` | Provider-agnostic; unified API; already a dependency via ADR-0002 |
| LangChain / LlamaIndex | Heavy abstractions; many transitive dependencies; overkill for a single call primitive |
| Custom fetch wrapper | Maximum control; maintenance burden |

---

## Decision

Use **`@mariozechner/pi-ai`'s `completeSimple`** as the sole LLM call primitive, with
**two independently-configurable model roles** controlled by environment variables.

### Model roles

| Role | Env var | Default | Used by |
|------|---------|---------|---------|
| Main | `MODEL` | `claude-sonnet-4-6` | `runInnerLoop`, reflection pass, Research sub-loop |
| Vision | `VISION_MODEL` | `claude-haiku-4-5-20251001` | `FetchUrl` (image caption), `InspectImage`, `BrowseWeb` |

The roles are independent. A typical production configuration uses Claude Sonnet for
reasoning and a cheaper model for vision:

```bash
MODEL=claude-sonnet-4-6
VISION_MODEL=mistralai/ministral-14b-2512   # OpenRouter; ~10× cheaper per image caption
```

### Model ID convention

```typescript
// models.ts — parseModel(id: string): Model
// "/" in the ID → OpenRouter model
// bare string    → Anthropic Claude model
parseModel("deepseek/deepseek-v3.2")   // → OpenRouter
parseModel("claude-sonnet-4-6")        // → Anthropic
```

Anthropic models are constructed via `anthropicModel(id, costOpts)` with explicit token
pricing so the cost accumulator is accurate for any Claude model. OpenRouter models are
fetched from `pi-ai`'s generated model registry via `getModel("openrouter", id)`.

### Provider key handling

`pi-ai` reads provider API keys from environment variables automatically:

| Provider | Key read by pi-ai |
|----------|-------------------|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |

No explicit key wiring is needed in MAGI V3 code. `OPENROUTER_API_KEY` is only required
when an OpenRouter model is actually selected; the key is never forwarded to agent
subprocesses (daemon env only).

### Named model constants

`models.ts` exports named constants for known models:

```typescript
CLAUDE_SONNET   // claude-sonnet-4-6: main loop default
CLAUDE_HAIKU    // claude-haiku-4-5-20251001: vision default
DEEPSEEK_V3_2   // deepseek/deepseek-v3.2: text, strong reasoning, cheap (~$0.25/$0.38)
MINISTRAL_14B   // mistralai/ministral-14b-2512: text + image, cheap vision (~$0.20/$0.20)
```

Constants are used for `CLAUDE_SONNET` and `CLAUDE_HAIKU` to avoid the `parseModel`
runtime lookup on the hot path. All other models go through `parseModel`.

---

## Rejected alternatives

**Single hardcoded model**: rejected because vision tasks account for 60–80% of LLM call
volume in image-heavy research; using Claude Sonnet for every image caption is 10–20× more
expensive than a dedicated vision model without quality benefit.

**Separate API keys per provider in MAGI V3 code**: rejected because pi-ai already handles
this. Adding our own key management would duplicate logic and create drift.

**LangChain**: rejected. The only primitive needed is `completeSimple(model, messages, options)
→ AssistantMessage`. LangChain's abstractions (chains, agents, callbacks) are not used and
add significant dependency weight.

---

## Consequences

- `OPENROUTER_API_KEY` is an optional runtime secret. Omitting it when `VISION_MODEL` is an
  OpenRouter model causes `BrowseWeb` tool creation to fail at startup with a clear error.
- `completeSimple` is the only LLM call in the codebase. There is no streaming; SSE updates
  in the dashboard are triggered by message persistence events (MongoDB Change Stream → monitor
  server push), not by streaming LLM output.
- Cost tracking in `llm-call-log` and `UsageAccumulator` is accurate only for Anthropic models
  (where pricing is explicitly set in `anthropicModel()`). OpenRouter models report cost from
  the API response's `usage.cost` field when available; otherwise cost is recorded as 0.
- Adding a new provider requires: (1) confirming pi-ai supports it in `env-api-keys.ts`, (2)
  adding the API key to the execution plane machine env in `fly-machines.ts`, (3) testing that
  tool-use (function calling) works correctly for that provider — not all OpenRouter-proxied
  models support tool use.

## Files

| File | Role |
|------|------|
| `src/models.ts` | Named constants, `anthropicModel()`, `parseModel()` |
| `src/daemon.ts` | Reads `MODEL` and `VISION_MODEL` env vars; constructs model objects |
| `src/loop.ts` | Accepts model object in `InnerLoopConfig`; passes to `completeSimple` |
| `src/tools/browse-web.ts` | Reads `OPENROUTER_API_KEY` when vision model is OpenRouter |
| `src/tools/fetch-url.ts` | Uses `visionModel` from `AgentRunContext` for image captioning |
