---
name: magi-template-design
description: |
  How to read MAGI mission templates and help the operator pick one to launch,
  plus the YAML structure, system prompt and mental map conventions, teamFiles
  contents, and the ProposeAction workflow for launching and customizing a
  running session.
---

# Mission Template Design

Templates are **immutable, disk-authored files** (`config/teams/*.yaml`), loaded once at
control-plane startup (ADR-0021). There is no template create/edit/version/rollback capability
anywhere in the running system — `list_templates`/`get_template` are read-only. To change a
template, a developer edits the YAML file on disk and redeploys; that is out of your reach as the
copilot. Your job is to help the operator **choose** the right template to launch a mission from,
then help them **customize the running session afterward** via `save_session_config` (below) —
never to author or version templates yourself.

## Choosing and launching a template

1. Call `list_templates` and, if needed, `get_template` on a candidate to check its mission
   roster, prompts, and teamFiles against what the operator wants.
2. If nothing fits well, say so plainly — don't try to force-fit a mismatched template. The
   operator's options are: launch the closest template and customize it afterward via
   `save_session_config` (below), or ask a developer to add a new template file to the repo.
3. Propose `launch_mission: { missionId, name?, templateId }` — operator confirms.

## Editing a live session config

A session must be **suspended** before its config can be edited:
1. Propose `suspend_mission` — wait for confirmation
2. Propose `save_session_config` with `{ missionId, teamConfigYaml, teamFiles?, mentalMaps? }`
3. Operator confirms → config saved; propose `resume_mission` when ready

`mentalMaps` is optional: `{ [agentId]: htmlString }` — updates each agent's persisted
mental map before the next wakeup.

## Reference: reading a template's YAML structure

Useful when comparing candidate templates or explaining one to the operator:

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

### System prompt conventions

**Include:**
1. Role identity — who the agent is and what its mission is
2. Output contract — what it produces, for whom, in what format
3. Non-default behaviours — principles the model won't apply without instruction
4. Filesystem orientation — where to read/write (`{{sharedDir}}`, `{{workdir}}`)
5. `{{mentalMap}}` placeholder — required

**Omit:**
- Behaviours already built into the model (honesty, reasoning, tool use)
- Capability details already covered by a skill (put those in a skill file instead)

### Mental map conventions

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

**Vs. a skill**: the mental map is for what's specific to *this* agent's own unfolding
history — current state, commitments, things it has actually observed — not general
reference material or procedure, even if it feels durable. Reusable "how to do X" content
belongs in a skill instead (see "Omit" above): skills are re-copied fresh into
`shared/skills` on every provision (including every resume), so a fix you make to one
later reaches every mission that uses it automatically, and cost context only when
actually read. Content seeded into a template's `initialMentalMap` has no such
propagation — it's frozen at whatever it was when the template was written, and costs its
full length every turn, forever, for every mission launched from it.

### teamFiles conventions

| Path | Purpose |
|------|---------|
| `skills/{name}/SKILL.md` | Custom skill (mission tier, discovered by all agents) |
| `OPERATOR_GUIDE.md` | Human-readable guide written to sharedDir root |
| `references/{name}.md` | Reference documents agents may consult |
| `playbook.json` | Structured data the agent reads at start |

Never put platform skill *files* (`run-background`, `schedule-task`, `objectives`, etc.) in
teamFiles — the skills themselves are always present regardless. (The objectives **data** files
below are the one exception: they configure the always-present objectives skill.)

### Objectives, tasks & KPIs (the outcome spine)

Every mission has the **`objectives` platform skill** available automatically. A template opts a
mission into it by shipping an objectives **data** file as a teamFile — the skill itself is never
shipped as a teamFile.

**Do not tell the operator you "added the objectives/task skills" — and do not put skill files in
teamFiles.** The skill is always present at runtime; what a template adds is the **data**
(`objectives/goals.json`, optionally `objectives/tasks.jsonl`). So the operator will correctly see
only those JSON files in teamFiles, never skill files. Describe it that way: "this template ships
objectives data; the objectives skill itself is always available to every mission."

What outcome-driven templates ship:

1. **`objectives/goals.json`** — the objective tree + KPI definitions + budgets. Objectives nest
   via `parent`; each has an `owner` (the supervisor agent accountable for it). KPIs hang off
   objectives; each has an `owner` + a `source`: `auto-stat` (computed from stats, e.g.
   `metricKey: "objectiveCostUsd"`), `task-rollup` (computed from task completion),
   `agent-reported` (an agent publishes it), `copilot-assessment` (the copilot judges a rubric),
   or `manual`.

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

   **Exact field names — do not improvise (an invalid `goals.json` fails to load and the cockpit
   shows an error):**
   - **Objective**: `id`, `title`, `owner` (required); `parent`, `status`, `budgetUsd`, `kpis`
     (optional). Do NOT add a top-level `"mission"` key.
   - **KPI**: `id`, `label`, `owner`, `kind`, `source` (ALL required); `target`, `unit`,
     `metricKey`, `rubric` (optional).
     - `label` — NOT `title`. `owner` — NOT `assignee`. `kind` is `"quantitative"` or
       `"qualitative"` — NOT a `"type"` field. `source` is one of
       `auto-stat | task-rollup | agent-reported | copilot-assessment | manual`.
     - A rubric-judged KPI an agent reports → `"kind":"qualitative","source":"agent-reported"`,
       plus an optional `"rubric"`. A copilot-judged one → `"source":"copilot-assessment"`.

2. **`objectives/tasks.jsonl`** (optional) — one initial task per line, assigned to agents:
   ```
   {"id":"TASK-1","at":"2026-01-01T00:00:00.000Z","by":"user","title":"Pull prices","objective":"OBJ-1.1","assignee":"data-scientist","status":"open"}
   ```
   (Or let a lead agent create tasks at runtime with the `AddTask` tool.)

3. Each agent is shown its owned objectives, owned KPIs, and open tasks in a synced **"Your
   objectives"** section of its mental map (injected, not authored). Agents keep it current via
   the objectives tools:
   - `UpdateTask(id, status, effort)`
   - `RecordKpi(kpi, value)`
   Read `$SHARED_DIR/skills/_platform/objectives/SKILL.md` for the full reference.

Status values: `open | in-progress | blocked | completed | deferred | cancelled`. The operator
watches all of this in the Mission Cockpit, and cost is attributed to tasks/objectives
automatically.
