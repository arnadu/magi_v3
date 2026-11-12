---
name: magi-template-design
description: |
  How to create a new mission with the operator: design the team, build it as a
  draft the operator can review and edit, launch it with one confirmation, and
  check its first run. Also how to change a running mission, and how to read
  templates.
---

# Creating and changing missions

Writing good prompts, mental maps and objectives is the `agent-design` skill: read it before
you write any agent. This skill is the workflow.

## A new mission: draft first, one confirmation

1. **Design with the operator.** Restate the goal; propose the team (agents, who reports to
   whom, what each produces), the model and its price, and a spend cap. Ask only what you
   can't decide sensibly yourself, in one message. Look at the templates (`ListTemplates`,
   `GetTemplate`) for a close match worth starting from, but a blank draft is fine.
2. **Build the draft** once the operator agrees. None of these steps needs a confirmation: a
   draft has no machine and spends nothing.
   - `CreateDraft { missionId, name, templateId? }` — a lowercase slug id, the operator's name
     for it, and a template only if it fits.
   - `EditDraftConfig` — set `mission` (name, model, `maxCostUsd`) and the agents
     (`agents` upserts by id, `removeAgentIds` drops template agents you don't want). Add team
     files (skills, reference documents) with `teamFiles`.
   - `SaveObjectiveTree` — the objectives and KPIs (its description has the exact fields).
   - `ReadMissionConfig` — check the result.
3. **Hand it to the operator for review.** Tell them the draft is ready, what it contains in
   a few lines, and that they can open it from the missions list (it shows a "draft" badge) to
   read or edit anything before launch.
4. **Propose `launch_draft { missionId }`.** It is checked against the stored draft when you
   propose it: if it reports a problem, fix the draft and propose again, before the operator
   sees a card. Read the draft again first (`ReadMissionConfig`): the operator may have edited
   it, and the launch uses the draft as it is when they confirm.
5. **When you are told the launch executed**, tell the operator, then check the first run: the
   mission status, its log and mailbox, and the agents' mental maps (`agent-design`, "first-run
   review"). If the launch failed, read the error, fix the draft, propose again, and say what
   you changed.
6. **Recurring work**: propose `create_schedule` for each recurring duty once the mission is
   running, or make setting up its own schedule the lead agent's first task.

You are sent a message whenever the operator confirms or dismisses one of your cards, or when
it fails: continue the workflow then, without waiting to be asked. Never leave a proposal
hanging without saying so to the operator.

## Changing a running mission

Agents and settings of a running mission change only while it is suspended:
1. Propose `suspend_mission`; wait for the message that it executed.
2. Propose `save_session_config { missionId, mission?, agents?, missionCopilotLimits?,
   teamFiles?, mentalMaps? }`: `mission` is merged; `agents` are upserted by id, and **an
   entry replaces that whole agent**, so include every field (copy it from
   `ReadMissionConfig` and change what you need) — to retire an agent, send its full entry
   with `active: false`; `teamFiles` replaces the whole set; `mentalMaps`
   replaces the live map of the agents named. The spend cap is not part of it: use
   `set_mission_budget`. It is checked against the stored config when you propose it.
3. When it executed, propose `resume_mission`. Never propose the resume before the config
   change has executed: a resume confirmed first runs the old config.

Objectives can change at any time, without suspending (`SaveObjectiveTree`).

## Templates

Templates are files in the repository (`config/teams/*.yaml` plus a folder of team files);
you can read them (`ListTemplates`, `GetTemplate`) but not change them. Use one as a starting
point in `CreateDraft { templateId }` when it is close to what the operator wants. A template's
agents, settings and team files are copied into the draft; edit them there.

Team files are written into the mission's shared folder at every boot:

| Path | Purpose |
|---|---|
| `skills/<name>/SKILL.md` (plus `scripts/`) | A team skill: listed for every agent with its path |
| `references/<name>.md` | Reference material agents read on demand |
| anything else | Copied to the same path under the shared folder |

Platform skills (`objectives`, `schedule-task`, `run-background`, ...) are always present; never
copy them into team files. Objectives are not team files: they live in the objectives store
(`SaveObjectiveTree`).
