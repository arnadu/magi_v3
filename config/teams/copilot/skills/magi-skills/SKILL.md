---
name: magi-skills
description: |
  How the MAGI skills system works: tiers, discovery, SKILL.md format,
  and how to create and deploy custom skills to templates or live missions.
---

# MAGI Skills System

## Architecture

Skills are Markdown instruction files discovered by agents at runtime. They extend an
agent's capabilities without touching the system prompt. Each skill lives at
`{tier-dir}/{skill-name}/SKILL.md`.

## Four tiers (highest wins on name collision)

| Tier | Location | Writable by agents? |
|------|----------|---------------------|
| Platform | `sharedDir/skills/_platform/` | No |
| Team | `sharedDir/skills/_team/` | No |
| Mission | `sharedDir/skills/mission/` | Yes |
| Agent-private | `workdir/skills/` | Yes |

## Platform skills (always present — never put in teamFiles)

Every launched mission automatically receives these five skills, injected from
`packages/skills/` at provision time. Do not include them in a template's `teamFiles`:

- **git-provenance** — commit completed work to the mission git repo
- **skill-creator** — create new mission or agent-private skill packages
- **inter-agent-comms** — structured agent-to-agent message protocol
- **run-background** — submit long-running scripts as background jobs
- **schedule-task** — register recurring scheduled agent wakeups

## Adding a custom skill to a template

Include it in `teamFiles` at path `skills/{name}/SKILL.md` (no tier prefix — no
`_platform/` or other prefix). At provision time this is written to
`sharedDir/skills/{name}/SKILL.md` and discovered under the mission tier.

Use ProposeAction `save_template`:
```json
{
  "type": "save_template",
  "payload": {
    "id": "my-template",
    "name": "My Template",
    "teamConfigYaml": "...",
    "teamFiles": [
      { "path": "skills/my-skill/SKILL.md", "content": "---\nname: my-skill\n..." }
    ]
  }
}
```

## Adding a skill to a live mission (no relaunch)

Use ProposeAction `write_mission_file`:
```json
{
  "type": "write_mission_file",
  "payload": {
    "missionId": "my-mission",
    "path": "skills/my-skill/SKILL.md",
    "content": "---\nname: my-skill\n..."
  }
}
```
The agent discovers the skill on its next wakeup.

## SKILL.md format

```
---
name: skill-name              # required; lowercase, hyphens only
description: |                # required; 1–3 lines shown in the agent's skill list
  What this skill does.
  Use when: short trigger condition.
---

# Skill Title

## Purpose
Why this skill exists and when to use it.

## Usage
Step-by-step instructions with explicit paths and copy-paste commands.
```

Rules:
- `name` must match the directory name
- `description` is trimmed to the first non-empty line for the inline list display
- Scripts go in a `scripts/` subdirectory alongside `SKILL.md`
