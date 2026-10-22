---
name: cost-management
description: |
  Interpreting mission spend stats, recognising alarming burn rates, reducing costs
  on running sessions, and handling a mission paused at its spend cap.
---

# Cost Management

## Spend stats fields

**Do not trust `GET /api/missions/stats` for spend figures** — it aggregates
`llmCallLog` on fields that collection doesn't actually have, over a
collection that's pruned to 1 day anyway (tracked as issue #53; not fixed by
this skill, since the route itself isn't yours to fix). Use `missionStats` and
`agentTurnStats` instead — the same collections `spend-cap-near`/`spend-spike`
below and the daily resource report are built from, so a number you compute
this way will always agree with what an alert or the report already told you.

| Field / query | Meaning |
|-------|---------|
| `missionStats.lifetimeCostUsd`, summed across an agent's docs for the mission | All-time cost for this mission (USD) |
| `agentTurnStats.costUsd` summed over `startedAt` in the last 24h | Cost in the last 24 hours |
| `missionStats.lastTurnAt`, max across agents | Timestamp of the mission's last turn |

These figures reflect LLM API costs only — they do not include Fly.io compute
or data API costs.

## Burn rate reference

| Burn rate (last hour) | Likely cause | Action |
|----------------------|--------------|--------|
| < $0.02 | Idle / sleeping | Normal |
| $0.02–$0.10 | Light scheduled work | Normal |
| $0.10–$0.50 | Active research, web browsing | Normal |
| $0.50–$1.50 | Heavy parallel agents | Monitor |
| > $1.50 | Possible loop or runaway | Investigate immediately |

## Diagnosing a cost spike

1. `ReadMissionLog` — look for the same agent dispatched again and again
   (`[orchestrator] Running <agent> … (N message(s))`)
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

## Paused at the spend cap

When a mission's lifetime spend reaches its cap (`mission.maxCostUsd`; new missions start at
$25), the whole mission pauses:
- No agent is dispatched, and every running turn waits before its next LLM call
- Background jobs' Research/FetchUrl/InspectImage calls are refused (their scripts see a 503)
- The log shows `[monitor] Budget cap $X reached ($Y spent) — pausing`; a hard `limit-breach`
  anomaly and a "Mission spend cap reached" mail to the user are sent
- The machine stays running (the daemon is alive)

Raising the cap resumes the paused turns where they stopped:
1. Tell the operator the spend, the cap and which mission is paused
2. If the spend is justified, propose `set_mission_budget` with the new cap — it cannot exceed
   the mission's ceiling (`maxCostCeilingUsd`), which only the operator can raise from the
   cockpit's Limits tab
3. Otherwise suggest suspending the mission and reviewing its config before resuming

## Cost attribution

`missionStats` has one document per `(missionId, agentId)` with its own
`lifetimeCostUsd` — already per-agent; the cockpit's Limits tab shows that lifetime view. You have no database access (and should never ask for a connection
string): for a time-windowed per-agent breakdown ("who drove the last 24 h"), point the
operator at the cockpit's Trace tab, or send the mission copilot a message (a one-off
`create_schedule` to `mission-copilot`) — its `ReadMissionCostSeries` tool has that view.

## `spend-cap-near` (ADR-0032)

Relayed as an anomaly at 90% (soft) and 98% (hard) of a mission's own spend
cap (`mission.maxCostUsd`), or as a "Spend" flag in the daily report. This is
proactive — it fires before the mission pauses at its cap (see above), so you have room to
act deliberately
instead of reacting to an already-paused mission.

1. Check the burn rate (above) to see whether this is a sustained climb or a
   temporary spike that's already slowing down.
2. If it's a genuine runaway agent, propose `pause_agent` on the specific
   agent driving it (from the per-agent attribution above) rather than the
   whole mission — this stops the bleeding without interrupting agents that
   are working fine.
3. If the spend is legitimate for what the mission is actually doing, propose
   `set_mission_budget` to raise the cap — but only within whatever ceiling
   the operator has configured (`maxCostCeilingUsd`, operator-only); if the
   requested raise would exceed it, explain that to the operator rather than
   silently capping your own request.

## `spend-spike` (ADR-0032)

Soft-only: 24h spend more than 3x the trailing 7-day daily average, and above
$5 (so a quiet mission's normal day-to-day noise never qualifies). Unlike
`spend-cap-near`, this isn't about a cap at all — a mission with no cap
configured can still spike. Use the per-agent attribution query above scoped
to the last 24h to find which agent's activity actually changed, then decide
whether that's expected (a legitimately bigger task today) or worth a note —
this flag on its own is informational, not a signal to act automatically.
