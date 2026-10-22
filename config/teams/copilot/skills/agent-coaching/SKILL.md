---
name: agent-coaching
description: |
  How to write effective guidance messages to running agents, patch mental maps
  to correct agent state, and decide between a message, a map edit, or a restart.
---

# Agent Coaching

## Decision: message vs mental map patch vs restart

| Situation | Recommended action |
|-----------|-------------------|
| Agent is confused about current task | Send a message with clear instructions (see below) |
| Agent has wrong beliefs about its state (tracked data, commitments) | Patch the mental map section |
| Both message and state are wrong | Patch mental map, then send a message |
| Agent is in a loop and ignoring inbox | Suspend, patch mental map, resume, then send a message |
| System prompt or tools are wrong | Suspend, edit config (save_session_config), resume |

## Writing effective messages to agents

You cannot post to a mission agent directly: your `PostMessage` reaches only the user. To
deliver a message, propose a one-off `create_schedule` (`ProposeAction`) with `to: [agentId]`,
your `subject` and `body`, and `deliverAt` about a minute from now. Once the operator confirms
it, the control plane delivers it to the agent's inbox (waking the machine if needed). For
anything urgent, you can also ask the operator to send it from the cockpit.

Messages arrive in the agent's inbox and are read at the next wakeup. The agent sees
them as `user` messages formatted with sender, timestamp, and content.

**Message structure that works:**
1. One sentence stating what happened or what context has changed
2. One sentence stating what the agent should do now (specific, not vague)
3. Any data or file paths the agent will need (exact paths, not "check the workspace")

**What to avoid:**
- Vague instructions ("do better", "try again") — agent will repeat the same behaviour
- Long explanations — agent context is finite; get to the directive quickly
- Multiple competing instructions in one message — pick the most important one

**Example — recovering a stuck researcher:**
```
The web search you ran earlier returned stale data (pre-2024). Please re-run the
search with date filter "after:2024-01-01" and write the updated findings to
shared/research/gold-demand-2025.md before proceeding.
```

**Example — redirecting an agent that went off-track:**
```
Your current task is the daily brief, due at 09:00 UTC. The sector analysis you
started is out of scope for today. Please pause it, save your progress to
shared/sector-wip.md, and focus on the brief.
```

## Patching the mental map

The mental map is the agent's durable structured memory. Use `save_session_config`
with a `mentalMaps` payload to correct specific sections without a full restart.

**The mission must be suspended before `save_session_config` will work.**

### How to build the patched HTML

The mental map is an HTML string, and `mentalMaps` **replaces the agent's whole map** — there
is no per-section merge. To patch a single section:
1. Read the current map with `ReadMentalMap({ missionId, agentId })`
2. Identify the `<section id="...">` element to replace
3. Build the new section HTML and splice it into the map you read, leaving every other
   section exactly as it was (in particular `#my-objectives`, which the daemon maintains)
4. Pass the full updated HTML string in `mentalMaps: { [agentId]: fullHtml }`

**Example payload** (the `…` stands for the rest of the map you read, unchanged):
```json
{
  "type": "save_session_config",
  "payload": {
    "missionId": "gold-digest-001",
    "mentalMaps": {
      "lead-analyst": "…<section id=\"status\"><p>Ready. Awaiting daily brief task.</p></section>…"
    }
  }
}
```

**When to patch vs replace the full map:**
- Targeted correction (one section wrong) → patch just that section, keep the rest
- Agent's entire state is corrupted → replace the full map with a clean version derived
  from `initialMentalMap` in the team config

## Injecting skills or reference data into a running mission

If an agent needs a skill or reference document it doesn't have:

```json
{
  "type": "write_mission_file",
  "payload": {
    "missionId": "gold-digest-001",
    "path": "skills/mission/my-skill/SKILL.md",
    "content": "---\nname: my-skill\ndescription: ...\n---\n# ..."
  }
}
```

The agent discovers the new skill on its next wakeup (no restart needed).

## What agents cannot see between turns

- Tool call results from previous turns (only the conversation summary survives compaction)
- Files written to workdir unless the agent recorded the path in its mental map or output
- Messages that were marked read before the agent processed them

Keep this in mind when coaching: if you reference something the agent wrote, confirm
it exists via `ReadMissionFile` before asking the agent to read it.
