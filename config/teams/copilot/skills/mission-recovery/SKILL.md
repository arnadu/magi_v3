---
name: mission-recovery
description: |
  Diagnostic and recovery workflows for stuck or failed missions: failure mode
  signatures, step-by-step procedures, and escalation criteria.
---

# Mission Recovery

## Standard diagnostic sequence

Always run these steps in order before proposing any action:

1. `GetMissionStatus({ missionId })` — Fly machine state, volume, IP
2. `ReadMissionLog({ missionId, lines: 100 })` — recent daemon + orchestrator output
3. `ReadMissionMailbox({ missionId, limit: 20 })` — recent messages in/out
4. `ReadMissionFile({ missionId, path: "shared/" })` — workspace state if needed

Only after completing the diagnosis, propose a remediation.

## Common failure modes

### 1. Agent timeout (most common)

**Signature in log:**
```
[orchestrator] agent error { agentId, error: "Agent run timed out" }
```
**What happened:** The agent's inner loop ran for longer than `MAX_AGENT_RUN_SECONDS`
(default 4 hours) without completing. The run was aborted.

**Recovery:**
- The agent's incomplete turn was discarded; no partial state was saved
- Usually safe to resume — the daemon will wake the agent again on next inbox message
- Propose `resume_mission` if the machine is stopped
- Consider posting a message to the agent with context about the interrupted task

### 2. Hard LLM error (transient: false)

**Signature in log:**
```
[orchestrator] agent error { transient: false, error: "..." }
```
**What happened:** A non-retryable error from the LLM provider — bad API key, credits
exhausted, model not found, or a 4xx from OpenRouter.

**Recovery:**
- Check the error message for the specific cause
- If credits / API key: operator must fix the secret before resuming
- If model not found: the model ID in the team config is invalid — edit config + resume
- Propose `suspend_mission` first if the machine is still running to stop burn

### 3. Stuck in provisioning

**Signature:** Mission status = `provisioning` in DB; no machine in Fly or machine
created but never started.

**Recovery:**
- If Fly machine exists: check machine state — it may be `stopped` and needs `resume_mission`
- If no Fly machine exists: the DB record is orphaned. The mission cannot be recovered via
  normal controls. Alert the operator — they must delete the record manually if needed.

### 4. Daemon not waking up (agent ignoring inbox)

**Signature:** Unread messages in mailbox, no recent log entries, machine is `running`.

**Recovery:**
1. Check if the machine is truly running: `GetMissionStatus`
2. Read daemon log — look for Change Stream errors or crash loops
3. If Change Stream error: propose `suspend_mission` + `resume_mission` (restarts daemon)
4. If log is empty / machine just started: give it 60s to reconnect to MongoDB

### 5. Agent in a reasoning loop

**Signature:** Log shows many consecutive turns with `Turn complete` but no useful output
in mailbox; spend climbing rapidly.

**Recovery:**
1. Read mailbox to confirm agent is not producing useful output
2. Propose `suspend_mission` to stop the burn immediately
3. Read conversation history via `ReadMissionFile` to understand what the agent is doing
4. Craft a recovery message explaining what went wrong and what to do instead
5. Propose `resume_mission` after the operator confirms the message looks right

### 6. Tool subprocess crash

**Signature in log:**
```
[tools] bash error: spawn sudo ENOENT
[tools] tool-executor exited with code 1
```
**What happened:** The tool executor (sandboxed subprocess) crashed. Common causes:
pool user doesn't exist, `magi-node` wrapper missing, sudoers rule stale.

**Recovery:** This is an environment problem, not a mission problem. Alert the operator —
likely requires `sudo env NODE_BIN=$(which node) scripts/setup-dev.sh` on the host.
In production (Fly.io), this should not occur — file a bug if it does.

## Recovery action reference

| Action type | When to use |
|-------------|-------------|
| `resume_mission` | Machine stopped; daemon crashed; after fixing config |
| `suspend_mission` | Stop burn; before config edit; runaway agent |
| `save_session_config` | Fix team YAML or mental map; mission must be suspended first |
| `write_mission_file` | Inject a new skill or data file into a running mission's workspace |
| Post message to agent | Guide agent past a stuck point; provide missing context |

## Escalation criteria

Escalate to the operator (do not attempt autonomous recovery) when:
- The root cause requires a secret rotation or env var change
- The mission has failed >3 times in the same session without a clear fix
- The Fly machine is in an unknown state not matching the DB
- Any data loss is possible (e.g. workspace files corrupted)
- The failure is in the control plane itself, not in the execution plane
