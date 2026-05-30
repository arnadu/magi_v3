---
name: cost-management
description: |
  Interpreting mission spend stats, recognising alarming burn rates, reducing costs
  on running sessions, and handling the budget-pause state.
---

# Cost Management

## Spend stats fields

From `GET /api/missions/stats` (call via Bash + curl, or use the dashboard):

| Field | Meaning |
|-------|---------|
| `spendTotal` | All-time cost for this mission (USD) |
| `spendToday` | Cost since midnight UTC today |
| `spendLastHour` | Cost in the last 60 minutes |
| `lastActivity` | Timestamp of the last conversationMessage |

These figures come from the `llmCallLog` collection and reflect LLM API costs only —
they do not include Fly.io compute or data API costs.

## Burn rate reference

| Burn rate (last hour) | Likely cause | Action |
|----------------------|--------------|--------|
| < $0.02 | Idle / sleeping | Normal |
| $0.02–$0.10 | Light scheduled work | Normal |
| $0.10–$0.50 | Active research, web browsing | Normal |
| $0.50–$1.50 | Heavy parallel agents | Monitor |
| > $1.50 | Possible loop or runaway | Investigate immediately |

## Diagnosing a cost spike

1. `ReadMissionLog` — look for rapid successive `Starting turn` / `Turn complete` pairs
2. `ReadMissionMailbox` — is the inbox filling faster than the agent can drain it?
3. Check which agent is active via log — is it the expected one?
4. `ReadMissionFile({ missionId, path: "shared/" })` — is output being produced?

A spike with no output usually means a reasoning loop. See `mission-recovery` skill.

## Reducing costs on a running session

In order of disruption (least to most):

1. **Disable expensive skills** — propose `save_session_config` with `disabledSkills`
   for agents that don't need BrowseWeb or Research. Requires suspend + resume.

2. **Reduce active agents** — set `active: false` on agents not needed right now.
   Requires suspend + save_session_config + resume.

3. **Switch to a cheaper model** — edit the `model` field in the team config.
   Cheaper options: `deepseek/deepseek-chat` (~10× cheaper than Claude Sonnet),
   `claude-haiku-4-5-20251001` (cheap for simple tasks).
   Requires suspend + save_session_config + resume.

4. **Suspend the mission entirely** — stops all compute; resume when needed.

## Budget-pause state

When a mission's cumulative spend exceeds `MAX_COST_USD` (set as an env var on the
Fly machine), the orchestrator enters budget-pause mode:
- All agent dispatches are halted
- The log shows `budget-pause` entries
- The machine stays running (daemon is alive) but no agents fire

**The operator must act** — the copilot cannot autonomously un-pause:
1. Inform the operator of the current spend and which mission is paused
2. Options for the operator:
   - Increase `MAX_COST_USD` — requires `fly machine update <id> --env MAX_COST_USD=<new>` on the execution plane
   - Suspend the mission and review config before resuming
   - Destroy the mission if no longer needed

## Cost attribution

Each `llmCallLog` entry has `missionId`, `agentId`, `model`, `inputTokens`,
`outputTokens`, `cost`, and `createdAt`. To identify which agent is driving costs,
run a query via Bash:
```bash
# Example: per-agent cost for a mission (adjust MONGODB_URI and DB as needed)
mongosh "$MONGODB_URI" --eval '
  db.llmCallLog.aggregate([
    { $match: { missionId: "gold-digest-001" } },
    { $group: { _id: "$agentId", total: { $sum: "$cost" } } },
    { $sort: { total: -1 } }
  ]).forEach(printjson)
'
```
