---
name: magi-template-design
description: |
  How to design a MAGI mission template: YAML structure, system prompt and
  mental map conventions, teamFiles contents, and the ProposeAction workflow
  for creating, editing, and launching templates and sessions.
---

# Mission Template Design

## Template YAML structure

```yaml
mission:
  id: template-id       # patched with the actual missionId at launch
  name: "Display Name"
  model: deepseek/deepseek-chat   # default model for all agents
  visionModel: claude-haiku-4-5-20251001

agents:
  - id: agent-id
    name: "Agent Name"
    role: one-line description
    linuxUser: magi-w1          # pool user in dev, per-agent user in prod
    supervisor: user            # who this agent reports to; "user" = operator
    model: override-if-needed   # omit to inherit mission model
    active: true                # set false to disable without removing
    disabledSkills: []          # list skill names to hide from this agent
    systemPrompt: |
      ...{{mentalMap}}
    initialMentalMap: |
      <section id="status"><p>Ready.</p></section>
```

## System prompt design

**Include:**
1. Role identity — who the agent is and what its mission is
2. Output contract — what it produces, for whom, in what format
3. Non-default behaviours — principles the model won't apply without instruction
4. Filesystem orientation — where to read/write (`{{sharedDir}}`, `{{workdir}}`)
5. `{{mentalMap}}` placeholder — required

**Omit:**
- Behaviours already built into the model (honesty, reasoning, tool use)
- Capability details already covered by a skill (put those in a skill file instead)

## Mental map design

The mental map is an HTML document injected into the system prompt every turn.
It persists across session compaction — it is the agent's durable structured memory.
Conversation context also survives compaction (as a summary), but the mental map is
always fully present and never trimmed.

Design around what must survive across wakeups:
- Current goal / task status
- Key tracked data points or commitments
- Active open questions

Use id'd elements (e.g. `<section id="...">`) for anything the agent should maintain —
the agent edits the map only through `mental_map_update` / `mental_map_add` /
`mental_map_remove`, which address elements **by id**. One id'd section per logical
domain. Anything **without** an id is permanent: put high-level structure, headings, and
standing instructions in non-id'd elements so the agent cannot change or erase them. Keep
it scannable; the operator sees it in the dashboard.

## teamFiles conventions

| Path | Purpose |
|------|---------|
| `skills/{name}/SKILL.md` | Custom skill (mission tier, discovered by all agents) |
| `OPERATOR_GUIDE.md` | Human-readable guide written to sharedDir root |
| `references/{name}.md` | Reference documents agents may consult |
| `playbook.json` | Structured data the agent reads at start |

Never put platform skill *files* (`run-background`, `schedule-task`, `objectives`, etc.) in
teamFiles — the skills themselves are always present regardless. (The objectives **data** files
below are the one exception: they configure the always-present objectives skill.)

## Objectives, tasks & KPIs (the outcome spine)

Every mission has the **`objectives` platform skill** available automatically. A template opts a
mission into it by shipping an objectives **data** file as a teamFile — you do not ship the skill.

**Do not tell the operator you "added the objectives/task skills" to the template — and do not put
skill files in teamFiles.** The skill is always present at runtime; what you add to the template is
the **data** (`objectives/goals.json`, optionally `objectives/tasks.jsonl`). So the operator will
correctly see only those JSON files in teamFiles, never skill files. Describe it that way:
"I added the objectives data; the objectives skill itself is always available to every mission."

To make a mission outcome-driven:

1. **Ship `objectives/goals.json`** (a teamFile) — the objective tree + KPI definitions + budgets.
   Objectives nest via `parent`; each has an `owner` (the supervisor agent accountable for it).
   KPIs hang off objectives; each has an `owner` + a `source`:
   `auto-stat` (computed from stats, e.g. `metricKey: "objectiveCostUsd"`), `task-rollup`
   (computed from task completion), `agent-reported` (an agent publishes it), `copilot-assessment`
   (the copilot judges a rubric), or `manual`.

   ```json
   {
     "objectives": [
       { "id": "OBJ-1", "parent": null, "title": "Publish the daily brief",
         "owner": "lead-analyst", "status": "active", "budgetUsd": 5.0,
         "kpis": [
           { "id": "K-cov", "label": "coverage", "owner": "lead-analyst",
             "kind": "qualitative", "source": "copilot-assessment" },
           { "id": "K-cost", "label": "cost", "owner": "lead-analyst",
             "kind": "quantitative", "source": "auto-stat",
             "metricKey": "objectiveCostUsd", "target": 5, "unit": "USD" }
         ] },
       { "id": "OBJ-1.1", "parent": "OBJ-1", "title": "Gather data",
         "owner": "data-scientist", "status": "active", "budgetUsd": 2.0, "kpis": [] }
     ]
   }
   ```

   **Use these EXACT field names — do not improvise (an invalid `goals.json` fails to load and
   the cockpit shows an error):**
   - **Objective**: `id`, `title`, `owner` (required); `parent`, `status`, `budgetUsd`, `kpis`
     (optional). Do NOT add a top-level `"mission"` key.
   - **KPI**: `id`, `label`, `owner`, `kind`, `source` (ALL required); `target`, `unit`,
     `metricKey`, `rubric` (optional).
     - `label` — NOT `title`. `owner` — NOT `assignee`. `kind` is `"quantitative"` or
       `"qualitative"` — NOT a `"type"` field. `source` is one of
       `auto-stat | task-rollup | agent-reported | copilot-assessment | manual`.
     - A rubric-judged KPI an agent reports → `"kind":"qualitative","source":"agent-reported"`,
       plus an optional `"rubric"`. A copilot-judged one → `"source":"copilot-assessment"`.

2. **Optionally ship `objectives/tasks.jsonl`** — one initial task per line, assigned to agents:
   ```
   {"id":"TASK-1","at":"2026-01-01T00:00:00.000Z","by":"user","title":"Pull prices","objective":"OBJ-1.1","assignee":"data-scientist","status":"open"}
   ```
   (Or let a lead agent create tasks at runtime with `task-add`.)

3. **Prompt the agents to use it.** Each agent is shown its owned objectives, owned KPIs, and open
   tasks in a synced **"Your objectives"** section of its mental map (do not author that section —
   it is injected). Tell agents to keep it current via the objectives skill scripts:
   - `bash $SHARED_DIR/skills/_platform/objectives/scripts/task-update.sh --id <id> --status <s> --effort <n>`
   - `bash $SHARED_DIR/skills/_platform/objectives/scripts/record-kpi.sh --kpi <id> --value <v>`
   Read `$SHARED_DIR/skills/_platform/objectives/SKILL.md` for the full command reference.

Status values: `open | in-progress | blocked | completed | deferred | cancelled`. The operator
watches all of this in the Mission Cockpit, and cost is attributed to tasks/objectives
automatically — so set realistic `budgetUsd` and assign clear owners.

## Creating a new template

1. Draft YAML and any teamFiles content
2. Propose `save_template` (omit `id` to mint a new one) — operator confirms — template visible immediately
3. The operator can open it in the config editor, adjust fields, and click "Start session ›"

## Editing an EXISTING template (read this carefully)

`save_template` **replaces** the whole template with a new version — it does not patch. Two rules
prevent the most common failures:

1. **Always pass the existing `id`.** Get it from `list_templates` and pass that exact `id` in the
   `save_template` payload. **If you omit (or change) `id`, you create a brand-new template instead
   of a new version of the one the operator is editing** — the operator's template will appear
   unchanged. The result message tells you which happened: *"saved as v2"* = you versioned the
   existing template (correct); *"created as NEW template"* = you forked a copy (wrong — re-do with
   the right `id`).
2. **Send the FULL, updated `teamConfigYaml`.** Apply your change to the *current* YAML (fetch it
   with `get_template` first) and submit the complete file. If you submit a stale or partial YAML,
   your change is lost even though the save "succeeds."

For a YAML-only edit, omit `teamFiles` — the previous version's teamFiles are preserved.

## Editing a live session config

A session must be **suspended** before its config can be edited:
1. Propose `suspend_mission` — wait for confirmation
2. Propose `save_session_config` with `{ missionId, teamConfigYaml, teamFiles?, mentalMaps? }`
3. Operator confirms → config saved; propose `resume_mission` when ready

`mentalMaps` is optional: `{ [agentId]: htmlString }` — updates each agent's persisted
mental map before the next wakeup.
