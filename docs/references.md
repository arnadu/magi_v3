# External References

Reference material for MAGI V3's upstream dependencies and predecessor project.
Read on demand — not needed for day-to-day development.

---

## MAGI v2 Baseline (`refs/MAG_v2` → `/home/remyh/ml/MAGI_v2/MAG_v2`)

V3 was built from scratch but draws on V2's patterns. Key V2 patterns carried forward:

**Stack**: TypeScript monorepo (npm workspaces) — `backend/` (Node.js/Express), `frontend/` (Vue.js), `packages/shared-types/`.

**Dev commands** (run from repo root):
```
npm run dev      # start backend + frontend + types concurrently
npm run build    # build types → frontend → backend
npm test         # backend integration tests
npm run lint     # ESLint on all workspaces
```

**Stateless backend pattern**: On every request, the entire conversation history is reloaded from MongoDB, state is reconstructed, processing occurs, results are persisted, and session state is discarded. V3 preserves this principle — all durable state lives in MongoDB.

**Agent loop**: Iterative LLM → tool → LLM cycles streamed to the frontend via SSE. Tool calls are executed sequentially; each call + result is saved to MongoDB and broadcast to the frontend before the next LLM call.

**Existing tools in V2** (defined in `backend/src/services/tools/`):
- `Editor` — modifies the Mental Map Document (shared HTML doc with id-targeted elements)
- `ResearchTool` / `LibrarianTool` — RAG-based document search
- `CritiqueTool` — self-assessment / reflection
- `WebSearchService`, `FetchService` — web search and content fetch
- `InspectImageTool`, `ImageGenerationTool` — vision and image generation
- `SubAgentService` — sub-agent delegation pattern

**Multi-LLM abstraction**: `backend/src/services/llm/` wraps OpenAI, Anthropic Claude, Google Vertex AI (Gemini), TogetherAI, and HuggingFace behind a unified provider interface.

**Design docs** (in `refs/MAG_v2/`):
- `DESIGN-ARCHITECTURE.md` — stateless backend, Mental Map concept, SSE patterns
- `DESIGN-AGENT-SYSTEM.md` — agent loop, tool integration, completion detection, sub-agents
- `DESIGN-LLM-INTEGRATION.md` — multi-provider abstraction, structured output, prompt engineering
- `DESIGN-DATA.md` — MongoDB schemas, vector search, rollback system
- `DESIGN-FRONTEND.md` — Vue.js client, SSE integration, Mental Map UI

---

## pi-mono (`refs/pi-mono` → `/home/remyh/ml/MAGI_v2/pi-mono`)

A separate TypeScript monorepo with reusable AI agent primitives.

**`@mariozechner/pi-ai`** (`packages/ai/`) — used directly since Sprint 1: `completeSimple(model, context, options?) => Promise<AssistantMessage>` is the non-streaming LLM call used by `runInnerLoop`. Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) with `completeSimple`, `streamSimple`, and `EventStream` primitives.

**`@mariozechner/pi-agent-core`** (`packages/agent/`) — production-ready agent loop with streaming, mid-run steering, follow-up messages, abort signals, and context window compaction. Deferred adoption — V3 has its own loop implementation.

**`@mariozechner/pi-web-ui`** (`packages/web-ui/`) — Lit-based web components for AI chat UIs. Still a candidate for the Sprint 16+ React frontend. Key components: `<pi-chat-panel>`, `<agent-interface>`, `<message-list>`, `ArtifactsPanel`, `registerToolRenderer()` pluggable tool renderer registry, `SessionsStore`/`ProviderKeysStore`/`SettingsStore` backed by IndexedDB.

**Build commands** (run from `refs/pi-mono/`):
```
npm install       # install all dependencies
npm run build     # build all packages
npm run check     # lint, format, type-check (requires build first)
./test.sh         # run tests (skips LLM-dependent tests without API keys)
```
