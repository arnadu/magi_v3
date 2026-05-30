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

Use `<section id="...">` elements — `UpdateMentalMap` patches by id. One section per
logical domain. Keep it scannable; the operator sees it in the dashboard.

## teamFiles conventions

| Path | Purpose |
|------|---------|
| `skills/{name}/SKILL.md` | Custom skill (mission tier, discovered by all agents) |
| `OPERATOR_GUIDE.md` | Human-readable guide written to sharedDir root |
| `references/{name}.md` | Reference documents agents may consult |
| `playbook.json` | Structured data the agent reads at start |

Never put platform skill files (`run-background`, `schedule-task`, etc.) in teamFiles —
they are always present regardless.

## Creating a new template

1. Draft YAML and any teamFiles content
2. Propose `save_template` — operator confirms — template visible in the UI immediately
3. The operator can open it in the config editor, adjust fields, and click "Start session ›"

## Editing a live session config

A session must be **suspended** before its config can be edited:
1. Propose `suspend_mission` — wait for confirmation
2. Propose `save_session_config` with `{ missionId, teamConfigYaml, teamFiles?, mentalMaps? }`
3. Operator confirms → config saved; propose `resume_mission` when ready

`mentalMaps` is optional: `{ [agentId]: htmlString }` — updates each agent's persisted
mental map before the next wakeup.
