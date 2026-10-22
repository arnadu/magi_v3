---
name: mission-monitoring
description: |
  Proactive health monitoring for running missions: status states, log patterns,
  spend thresholds, and when to alert the operator vs handle autonomously.
---

# Mission Monitoring

## Routine health check procedure

Run this when asked to check mission health, or proactively before reporting to the operator:

1. `ListMissions` — get current status of all missions
2. For each non-destroyed mission, `GetMissionStatus({ missionId })` — compare Fly machine
   state with DB status; flag discrepancies
3. `GET /api/missions/stats` (via Bash + curl) — pull unread counts and spend figures
4. For any mission with unread > 0 or recent errors: `ReadMissionLog` — scan last 50 lines

## Status state meanings

| Status | Fly machine state | Meaning |
|--------|------------------|---------|
| `running` | `started` / `starting` | Normal — daemon executing |
| `suspended` | `stopped` / `stopping` | Intentionally paused |
| `destroyed` | `destroyed` | Terminal — no recovery |
| `error` | anything else | Unexpected — investigate |
| `provisioning` | (creating) | Transient — should resolve in <2 min |

**Stuck provisioning:** If a mission has been `provisioning` for >5 minutes, something
failed silently. Check if a Fly machine was actually created. If not, the DB record is
orphaned — operator must decide whether to delete and retry.

## Log patterns

Read with `ReadMissionLog({ missionId, lines: 100 })`. Key signals:

| Pattern | Meaning |
|---------|---------|
| `[orchestrator] Running <agent> (<user>) (N message(s))` | Agent woke up to process its inbox |
| `[loop] 429 rate-limit …` / `[loop] transient error (…) — retrying` | Provider hiccup, retried automatically — usually fine |
| `[orchestrator] <agent>: LLM error #N — next dispatch no sooner than …` | The agent's LLM calls are failing; it is cooling down. An `llm-error` anomaly says why |
| `[orchestrator] <agent> exceeded Ns wall-clock limit — aborting` | A turn ran past `MAX_AGENT_RUN_SECONDS` and was stopped |
| `[orchestrator] <agent> error: …` | The agent's run crashed |
| `[monitor] Budget cap $X reached ($Y spent) — pausing` | Mission spend cap hit — every agent is paused until the cap is raised |
| No entries in >24 h (scheduled mission) | Possible missed cron — check the schedule (`ListSchedule`) |

## Spend thresholds (rough guidance)

These are heuristics — actual limits depend on the mission type:

| Burn rate | Assessment |
|-----------|-----------|
| < $0.05/hr | Idle or light usage — normal |
| $0.05–0.50/hr | Active research or data processing — normal |
| $0.50–2.00/hr | Heavy parallel runs — monitor |
| > $2.00/hr | Likely loop or runaway — investigate immediately |

## Healthy vs degraded signals

**Healthy mission:**
- Log shows `[orchestrator] Running …` entries at the expected cadence
- Unread count is 0 or low (agent keeping up with inbox)
- Spend within expected range
- No `LLM error #N` cooldowns or hard `llm-error` anomalies recently

**Degraded mission:**
- Unread count growing (agent not waking up or crashing per turn)
- Log shows repeated `LLM error #N` or `error:` lines for the same agent
- Long gap in log with no activity (daemon may be hung)
- Spend spiking without corresponding output

## When to alert the operator vs handle autonomously

**Handle autonomously (propose remediation, report outcome):**
- A single hard LLM error followed by silence — propose resume
- Agent stuck with known diagnosis (see mission-recovery skill) — propose fix + resume

**Always alert the operator:**
- Repeated failures (>3 errors on the same agent in one session)
- The mission is paused at its spend cap — the operator decides whether to raise the cap
  (`set_mission_budget`, up to the ceiling) or suspend the mission
- Disk / volume issues (writes failing)
- Mission stuck in `provisioning` > 5 minutes
- Any Fly machine state that doesn't match DB status
