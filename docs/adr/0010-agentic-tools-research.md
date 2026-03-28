# ADR-0010: Agentic Tools — Nested Inner Loops and the Research Tool

## Status

Accepted. Sprint 10.

## Context

The overnight cost analysis of the equity-research mission (Sprint 8) revealed three
compounding cost drivers:

1. **Cross-agent URL duplication**: The same URLs were fetched 5–10× across agents and
   sessions. `macrotrends.net/NVDA/history` was fetched 10 times; `stockanalysis.com/nvda`
   9 times. Each agent independently re-discovers and re-fetches the same sources.

2. **Search loops**: The economist made 38 `SearchWeb` calls and 20+ `FetchUrl` calls in a
   single session trying to pin down exact market data. When an initial search returned
   partial data, the agent retried with slight variations rather than using best-available.

3. **O(n²) cache cost**: With 30–60 LLM calls per session, context grows monotonically
   (each tool result body stays in context for all subsequent calls). A session of 47 calls
   growing from 7k → 91k tokens produced 2.2M cache read tokens — for a single session.

Sprint 9's session-boundary compaction addresses cross-session context growth. But within a
session, all tool result bodies remain in context for every subsequent LLM call. Sprint 9
compaction does not help with intra-session O(n²) costs, and it cannot prevent agents from
running 47-call sessions in the first place.

The root cause is architectural: main agents call `SearchWeb`, `FetchUrl`, and `BrowseWeb`
directly, so every search result and fetched article body lands in the main agent's context.
MAGI v2 solved this with a `Research` sub-agent that ran its own isolated inner loop —
the main agent only ever saw the final 200-word finding, never the intermediate tool calls.

---

## Decision

### Three tool categories

V3 tools are classified into three categories:

**Simple tools** — pure functions, no inner LLM loop, no session state:
`Bash`, `WriteFile`, `EditFile`, `PostMessage`, `UpdateMentalMap`, `ListTeam`,
`ListMessages`, `ReadMessage`, `SearchWeb`, `FetchUrl`, `InspectImage`

**Stateful tools** — maintain a live session object across `execute()` calls within one
agent turn. Created before `runInnerLoop`, closed in `finally`:
`BrowseWeb` — holds a Stagehand/Playwright browser session (cookies, navigation history).
Session is turn-scoped: alive for one `runAgent()` call, closed afterward.

**Agentic tools** — spawn their own `runInnerLoop` with a restricted tool set and a
specialized system prompt. Each `execute()` call creates and runs a complete mini agent.
The main agent's context never sees the sub-loop's internal messages — only the final
result is returned as the tool result:
`Research` (this ADR), potentially `DataAnalysis`, `CodeReview` in future sprints.

### Agentic tool statefulness

Statefulness has two independent dimensions:

**Execution state** — does the tool hold an open resource between calls?
`BrowseWeb` needs this (browser session). `Research` does not — there is no persistent
connection to hold between calls. Each `Research` call spawns a fresh inner loop.

**Knowledge state** — does the tool remember what it found in previous calls?
`Research` accumulates knowledge, but this state is **externalized** to the shared
filesystem (`sharedDir/research/`) rather than held in memory. This makes it:
- Durable across agent wakeups
- Visible to all agents on the same mission (cross-agent deduplication)
- Accessible via `Bash` without any special API

### The Research tool

`Research` is an agentic tool that:

1. Checks `sharedDir/research/index.json` for a recent cached answer to the same question.
   If found and within `max_age_hours`, returns immediately — zero LLM calls.
2. Otherwise runs a nested `runInnerLoop` with:
   - Specialized research system prompt
   - Restricted tool set: `SearchWeb`, `FetchUrl`, `Bash` (read-only use, sharedDir)
   - `maxTurns: 10` — forces synthesis when the limit approaches
3. Extracts the final assistant text response as the finding.
4. Writes the finding + source URLs to `sharedDir/research/<slug>.md` and appends an
   entry to `sharedDir/research/index.json`.
5. Returns the finding as the tool result.

**What the main agent's context sees:**
```
[user]       Research({ question: "NVDA closing price March 31 2026" })
[assistant]  <calls Research tool>
[toolResult] NVDA closed at $127.42 on 2026-03-31 (+1.8% on the day).
             Sources: stockanalysis.com/nvda/history, macrotrends.net/NVDA
```

The 5 `SearchWeb` calls, 3 `FetchUrl` calls, and 2 `Bash` reads that produced this answer
are invisible to the main agent. They ran in the sub-loop's isolated context.

### Research index

```
sharedDir/research/
  index.json           ← array of ResearchEntry, append-only
  nvda-price-20260331.md
  treasury-10y-20260331.md
  iran-war-status-20260327.md
  ...
```

```typescript
interface ResearchEntry {
  slug: string;         // filename stem
  question: string;     // exact question asked
  answer: string;       // synthesized finding (first 500 chars for quick scan)
  sources: string[];    // URLs consulted
  savedAt: string;      // ISO timestamp
  agentId: string;      // which agent ran this research
}
```

Cache lookup is exact-match on `question` (normalised to lowercase + trimmed). Semantic
similarity matching is deferred — agents can consult `index.json` directly via `Bash` and
decide whether a prior finding answers their question before calling `Research`.

### maxTurns in InnerLoopConfig

A new `maxTurns?: number` option is added to `InnerLoopConfig`. When the loop has run
`maxTurns` LLM calls, it exits the while loop — the LLM receives no further turns and the
last assistant message is whatever it produced at that call.

Used by agentic tools to bound sub-loop cost. The Research system prompt instructs the
sub-agent to synthesize with what it has as the limit approaches; `maxTurns` is the
mechanical enforcement that prevents indefinite searching.

Main agent loops continue with no cap (`maxTurns` undefined).

### Tool set for Research sub-loop

| Tool | Available | Reason |
|------|-----------|--------|
| SearchWeb | ✓ (if key present) | Core research capability |
| FetchUrl | ✓ | Fetch and cache web content |
| Bash | ✓ | Read existing artifacts from sharedDir |
| BrowseWeb | ✗ (Sprint 10) | Added when JS-rendered research is needed |
| WriteFile / EditFile | ✗ | Research does not write mission files |
| PostMessage | ✗ | Research does not communicate with agents |
| UpdateMentalMap | ✗ | Research does not modify agent state |

Bash is restricted by ACL to `sharedDir` only (no `workdir`). The Research system
prompt instructs read-only use — no writing files, no git operations.

### Main agent tool set changes

Main agents (lead-analyst, economist, junior-analyst, data-scientist) **retain** direct
access to `SearchWeb`, `FetchUrl`, and `BrowseWeb` in Sprint 10. These tools are not
removed — enforcement is via the system prompt ("delegate web research to Research").

Removing direct tool access is a future step once `Research` is proven reliable. Prompt
enforcement is sufficient for Sprint 10.

### Efficiency guidelines in agent system prompts

Each equity-research agent receives a new **"Research efficiency guidelines"** section:

```
## Research efficiency guidelines
- Delegate all web research to the Research tool — do not call SearchWeb or FetchUrl directly.
- Before calling Research, scan {{sharedDir}}/research/index.json to see if a teammate
  already answered the same question. Use `Bash` to read it: cat {{sharedDir}}/research/index.json
- Aim for ≤ 10 tool calls per session. If you need more than 3 Research calls to complete
  your note, you are over-scoping — narrow your focus.
- In Bash, always use grep -m 20 or head -n 50. Never cat an artifact file in full.
- If Research cannot find exact data, accept the best available approximation and document
  the uncertainty in your note. Do not retry the same question more than twice.
```

---

## Consequences

| | Outcome |
|-|---------|
| Main agent context size | Bounded: reasoning chain + Research findings only. Raw tool bodies (search results, fetched HTML) never enter main context. |
| Cross-agent duplication | Research index in sharedDir deduplicates at question level. URL-level deduplication: agents check existing FetchUrl artifacts via Bash before delegating. |
| Cost (intra-session) | Economist's 47-call session (91k peak) becomes ~5 Research calls + reasoning. Each Research sub-loop is isolated and bounded to 10 turns. |
| Cost (cache) | Main agent context stays flat (system prompt + summary + ~5 findings). Cache write on first call; all subsequent calls read the same small context. O(n²) → O(n). |
| Observability | Research sub-loop messages are not persisted to conversationMessages. Findings are durable in sharedDir/research/. LLM call audit log (Sprint 9) captures sub-loop LLM calls. |
| Crash safety | Research writes to sharedDir/research/ atomically (write file then append index). A crash between the two leaves an orphaned .md file — harmless; index is the authoritative cache. |

## Files

| File | Change |
|------|--------|
| `src/loop.ts` | Add `maxTurns?: number` to `InnerLoopConfig`; enforce in while loop |
| `src/tools.ts` | Export `createBashTool` for use by agentic tools |
| `src/tools/research.ts` | **NEW** — `createResearchTool`, `ResearchEntry`, index helpers |
| `src/agent-runner.ts` | Register `Research` tool; pass `sharedDir`-only ACL |
| `config/teams/equity-research.yaml` | Add efficiency guidelines to all four agent prompts |
| `docs/adr/0010-agentic-tools-research.md` | This document |

## Not in scope (deferred)

| Item | Rationale |
|------|-----------|
| Semantic similarity cache lookup | Exact match sufficient for Sprint 10; avoids LLM call on index lookup |
| BrowseWeb in Research sub-loop | Add when JS-rendered research is encountered in practice |
| Remove SearchWeb/FetchUrl from main agents | After Research tool is proven reliable |
| DataAnalysis agentic tool | Future sprint |
| maxTurns enforcement via structured output | Current approach: loop breaks, last assistant text used as-is |
