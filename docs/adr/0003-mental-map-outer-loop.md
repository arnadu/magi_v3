# ADR-0003: Mental Map as Outer-Loop State

## Status
Accepted

## Context

Agents need persistent working memory that survives across inner-loop runs, mailbox
deliveries, and Temporal replays. This memory must:
- Hold a prioritised task queue with deadlines and source references
- Store free-form working notes the agent updates during planning
- Track what the agent is waiting for from teammates
- Be readable and writable by the LLM in natural language
- Support surgical, idempotent updates (not full document overwrites)
- Be injectable into the inner-loop system prompt so the executing agent has full context

Candidates evaluated:
1. **Structured JSON document** — typed, queryable, but requires the LLM to emit valid JSON
2. **HTML document with stable element IDs** — free-form prose in structured sections;
   surgical patch by element ID
3. **Plain text scratchpad** — fully free-form; no structure for programmatic sorting

## Decision

Use an **HTML document per agent** stored in MongoDB, with stable section IDs and `data-*`
attributes on task list items.

```html
<section id="mission-context">...</section>
<section id="tasks">
  <ol>
    <li id="task-{id}" class="pending|in-progress|done|blocked"
        data-priority="{0-100}" data-deadline="{ISO}" data-source="{msg_id|schedule|self}">
      <!-- free-form prose -->
    </li>
  </ol>
</section>
<section id="working-notes">...</section>
<section id="waiting-for">...</section>
```

The `UpdateMentalMap` tool patches the document by element ID (`replace`, `append`, `remove`
operations) rather than replacing the entire document. This is surgical, idempotent, and
makes the diff between Mental Map versions meaningful.

This approach is adapted from MAG_v2's `Editor` tool, which proved HTML-with-element-IDs
in production for multi-agent document editing.

JSON was rejected because it requires the LLM to emit syntactically valid JSON for every
update, which degrades under pressure and produces hard-to-debug parse failures. HTML
tolerates partial edits gracefully.

Plain text was rejected because it provides no hook for programmatic priority sorting or
task status tracking.

## Consequences

- One MongoDB document per agent; `MentalMapRepository` manages persistence (in-memory
  implementation used in tests; MongoDB for production).
- `UpdateMentalMap` is available in the unified agent loop; agents call it freely to record
  progress, update working notes, or track what they are waiting for.
- The agent marks completed tasks `done` by calling `UpdateMentalMap` at completion.
- `data-priority` enables task sorting without LLM involvement.
- Mental Map HTML is injected verbatim into the system prompt via the `{{mentalMap}}`
  placeholder, substituted by `buildSystemPrompt(agent, mentalMapHtml)` before each run.
- The initial Mental Map HTML is defined per-agent in the team YAML (`initialMentalMap`
  field); section IDs (`mission-context`, `working-notes`, `waiting-for`) are stable
  across agents.
- `patchMentalMap(html, operation, elementId, content?)` is a pure function (jsdom-based);
  it returns `null` if the element ID is not found, allowing the tool to surface a clear
  error to the agent.
