# MAGI V3 — Operational Resilience

Failure mode and recovery analysis for the execution plane.  
Security failure modes are in `docs/security/threat-model.md` — this document covers operational failures only.

**Keep this document current.** Use `/operational-resilience` after any sprint that adds a new component,
persistence layer, external dependency, or long-running process. Each new layer is a potential new failure
mode that should appear in this document before it reaches production.

---

## Recently fixed

| Fix | Sprint | Gap closed |
|-----|--------|------------|
| Per-call LLM completion deadline (`deriveDeadline()`, default 8 min) in `loop.ts`, with `lastCallAborted` tracked through `agent-runner.ts`'s `finally` | 26 | Only tool calls were timeout-guarded (via a `withTimeout` that doesn't even cancel the underlying promise) — a stalled LLM completion call left a turn at `status:'running'` forever, with no way to distinguish it from a genuinely active turn. Found live: an analyst's turn was reported "running" long after the process had stopped making progress |
| `reconcileStaleRunning()` in `agent-stats.ts`, called at the start of every `StatsCollector.startTurn()` | 26 | Closes the Layer 6 gap below — any new turn starting for an agent now marks that agent's other stale `status:'running'` docs `aborted`, using the orchestrator's own guarantee (only one in-flight dispatch per agent) as the correctness argument |
| `MAX_JOB_RECOVERY_ATTEMPTS` circuit breaker in `job-recovery.ts` (extracted from `daemon.ts` for testability) | 26 | `recoverOrphanedJobs()` had no attempt cap — a job whose own execution crashed the machine (see next row) was recovered, re-run, crashed the machine again, and recovered again on every restart, indefinitely. Found live via a production OOM crash-loop; a job now fails permanently to `jobs/failed/` and notifies the owning agent (or `"user"`) after 2 recovery attempts |
| `DEFAULT_MAX_WORKERS = 5` bound (via `ThreadPoolExecutor`) on `catalog.cmd_refresh()`'s adapter fan-out, configurable per mission via `max_parallel_adapters` in `schedule.json` | 26 | Root cause of the OOM above: `refresh.py`'s background job spawned one subprocess per data source with no concurrency limit — a mission with many configured sources could launch dozens of adapter subprocesses simultaneously and exhaust the 1 GB execution machine |
| `workflow_dispatch` trigger added to `deploy-control-plane.yml`; control-plane redeploys now always go through CI (fresh cockpit build + explicit commit-sha image tag) | 26 | A bare local `flyctl deploy` (no `--image`, no cockpit rebuild step) had silently reverted the running control-plane machine to a stale image — the deployed cockpit bundle was one commit behind for two days before the mismatch was diagnosed. See §9 "Update the control plane" in `docs/deployment.md` |
| `MAX_AGENT_RUN_SECONDS` per-dispatch wall-clock timeout (default 4 h) in `orchestrator.ts` | 17 | Agent hung indefinitely — loop could freeze forever on a pathological tool call or unresponsive LLM |
| SSE `agent-status` payload changed to `{ running: string[] }` (concurrent set) | 18 | Agent status tracking was single-slot; concurrent dispatches caused incorrect "pending" state in dashboard |
| Mission Resume made non-blocking (HTTP 202 + background start) | 16 | WireGuard proxy 60 s timeout caused Resume to appear to fail while the machine actually started |

## Severity scale

| Symbol | Meaning |
|--------|---------|
| 🔴 | **Data loss** — work products, conversation history, or mission state are permanently lost |
| 🟠 | **Mission stall** — mission stops progressing; no data loss; operator action required |
| 🟡 | **Transient** — brief interruption; self-recovers or requires a trivial operator action |

---

## Layer 1 — Infrastructure (Fly.io)

| Failure | Effect | Severity | Current mitigation | Gap |
|---------|--------|----------|--------------------|-----|
| Execution machine crash / OOM | Daemon process killed; all in-process agent runs stop immediately | 🟠 | Fly Volume preserves mission dir and workdirs; MongoDB preserves full conversation + mailbox state; PID file cleaned on graceful exit, stale-detected on next start; **`restart: { policy: "on-failure", max_retries: 3 }` in machine config — machine self-heals up to 3 times** | None — G-1 closed |
| Execution machine OOM under Playwright | Machine killed by OOM killer at peak load (Chromium + Node + MongoDB driver) | 🟠 | 1 GB RAM provisioned; BrowseWeb uses lazy init | Peak can exceed 1 GB on complex pages; no OOM alert |
| Fly Volume unavailable | Daemon fails to start — cannot write PID file, read config, or access workdirs | 🟠 | Fly Volume HA within a region | No cross-region backup; no alerting |
| Fly Volume full | File writes fail (WriteFile, Bash output, git commits, logs) | 🔴 | None | No disk usage monitoring; fills silently |
| WireGuard proxy timeout | Browser request to dashboard times out (>60s) | 🟡 | Mission Resume made non-blocking; SSE reconnects with `retry: 3000` | None — auto-recovers |
| Control plane crash | Cannot launch missions or view UI; running missions unaffected | 🟠 | Control plane on separate always-on Fly app | No HA for control plane |

**Recovery — execution machine stopped:**
```bash
# Via control plane UI: Mission → Resume
# Via API:
curl -X POST https://magi-control-dev.fly.dev/api/missions/{id}/start \
  -H "X-API-Key: $CONTROL_API_KEY"
# Or directly via flyctl:
flyctl machine start <machineId> -a magi-missions-dev
```

~~**Gap G-1 (closed Sprint 20):** Machine auto-restart policy added.~~  
`fly-machines.ts` now includes `restart: { policy: "on-failure", max_retries: 3 }` in the machine config block. Machines self-heal after crash/OOM up to 3 times. Manual operator restarts are unaffected.

---

## Layer 2 — Persistence (MongoDB Atlas)

| Failure | Effect | Severity | Current mitigation | Gap |
|---------|--------|----------|--------------------|-----|
| Transient connection drop | `waitForMail` Change Stream errors | 🟡 | Exponential backoff retry (1 s → 30 s) in both daemon and monitor server | None — auto-recovers |
| Atlas replica set election (~30 s) | Same as transient drop | 🟡 | Same retry loops | None — auto-recovers |
| Extended Atlas outage (>30 min) | `waitForMail` returns error; orchestration loop exits; daemon shuts down cleanly | 🟠 | Loop exits and daemon removes PID file; MongoDB state intact | No alerting; operator may not notice |
| Write failure during `markRead` | Inbox messages marked read but agent run never started | 🟠 | Unlikely (Atlas HA); agent's mental map and conversation history preserve prior context | If it occurs, the specific inbox message text is unrecoverable; see G-2 |
| Collection quota exceeded | Agent writes fail; inner loop errors | 🟠 | High limits on paid Atlas tier | No quota monitoring |

**Recovery — extended Atlas outage:**  
Restart daemon after Atlas recovers. State is fully preserved in Atlas; no messages are lost (inbox messages are only marked read immediately before a successful `runAgent` call begins).

**Gap G-2 (moderate): Inbox messages lost if daemon crashes between `markRead` and agent completion.**  
The orchestrator marks messages read before calling `runAgent`. A crash in the narrow window between those two operations means those inbox messages are gone from the agent's next-session view. The agent's mental map and conversation history are intact, so it can resume, but it won't see the specific text from those messages. A two-phase approach (mark as `processing` → mark as `read` in `.finally()`) would close this window. Current assessment: low probability, moderate impact — acceptable for now given the mental map mitigates most practical cases.

---

## Layer 3 — Daemon process

| Failure | Effect | Severity | Current mitigation | Gap |
|---------|--------|----------|--------------------|-----|
| Crash (unhandled exception) | All agent runs terminate; PID file left on disk | 🟠 | Next start auto-detects stale PID via `process.kill(pid, 0)`; MongoDB state intact | No auto-restart (see G-1) |
| SIGKILL / OOM kill | Same; `finally` blocks do not run | 🟠 | Stale PID auto-detected; MongoDB write atomicity protects data | None |
| Graceful SIGTERM | Abort signal fires; orchestrator waits for active agents to finish their current tool call; PID file removed | 🟠 | Full graceful shutdown path | None |
| Second SIGINT (force-exit) | Hard exit; PID file not removed | 🟠 | Intentional; stale PID auto-detected on next start | None |
| Port 4000 / 4001 conflict on restart | Monitor / tool server fails to bind; daemon startup fails | 🟠 | PID check prevents two instances of same mission | Race window between hard kill and port release; `lsof -ti tcp:4000 \| xargs kill -9` resolves it |
| Team config edited while the mission is running (`SaveMissionConfig` tool, control-plane `PUT /:id/config`, or the cockpit Limits panel's `PATCH /:id/limits/*` routes) | Persisted correctly, but silently has no effect on the running process — `daemon.ts` reads `TEAM_CONFIG` once at boot and never re-reads it | 🟡 | Every one of these write paths posts a mailbox message stating the change "takes effect the next time the mission is resumed, not immediately"; `Limits` panel's mission-cap edit is the one exception — it additionally calls the running mission's own `/set-budget` for immediate effect, since that value already lives in mutable in-memory `MonitorServer` state | No live config re-read; an operator who doesn't read the confirmation message may assume an edit is already active |

**Recovery — stale daemon:**  
The daemon startup checks whether the PID in `daemon.pid` is alive (`process.kill(pid, 0)`). If the process is gone, the stale file is overwritten and startup proceeds normally. No operator action is needed beyond starting the daemon.

---

## Layer 4 — Orchestration loop

| Failure | Effect | Severity | Current mitigation | Gap |
|---------|--------|----------|--------------------|-----|
| Agent hung indefinitely | Agent occupies `active` map forever; loop freezes | 🟡 | `MAX_AGENT_RUN_SECONDS` (default 4 h) aborts dispatch via AbortSignal; `agent-error` SSE fires | 4-hour window may be long for production monitoring; lower with `MAX_AGENT_RUN_SECONDS` env var |
| LLM completion call stalls mid-stream (provider hangs, not a rate limit) | Previously: turn stuck at `status:'running'` until the 4 h dispatch backstop fired — reported as "hung" while nothing was happening | 🟡 | `deriveDeadline()` in `loop.ts` gives each individual completion call its own cancelling deadline (default 8 min, `llmCallTimeoutMs`), threaded through nested sub-loops (e.g. Research tool); `lastCallAborted` is checked in `agent-runner.ts`'s `finally` so the turn is correctly marked `aborted`, not silently left `running` | None — closed Sprint 26 |
| `maxRuns` cap reached | No further dispatches; daemon waits for mail indefinitely | 🟠 | Dashboard shows idle; operator can still send messages | No alert when cap is hit; operator must notice the idle state |
| `waitForBudget` with dashboard unreachable | Orchestrator blocks forever waiting for budget extension | 🟠 | Budget re-evaluated from accumulated costs on daemon restart | None |
| `waitForMail` never resolves (no new mail) | Orchestrator blocks correctly — this is normal daemon idle state | 🟡 | Intended behavior | None |

---

## Layer 5 — Scheduled messages

**This is the highest-severity gap for production equity research missions.**

The daily brief, weekly report, and event-alert wakeups all depend on `node-cron` delivering scheduled messages at the right time. `node-cron` runs entirely in-memory inside the daemon process.

| Failure | Effect | Severity | Current mitigation | Gap |
|---------|--------|----------|--------------------|-----|
| Daemon down when cron fires | Scheduled message is never delivered; that day's mission cycle is silently skipped | 🔴 | None | **G-3: Missed cron fires are not replayed** |
| Daemon restarts between cron fires | Cron state is reconstructed from `scheduled_messages` collection; next fire scheduled correctly | 🟡 | Daemon reloads schedule from MongoDB on startup | None for future fires; only missed fires are lost |
| `cancelSchedule` called concurrently with delivery | Document deleted; message not delivered | 🟡 | Low probability race; `deleteOne` is atomic | None |

**Gap G-3 (moderate): No catch-up delivery for missed cron fires.**  
On daemon startup, if any `scheduled_messages` entry has a `scheduledFor` timestamp in the past and was never delivered (`deliveredAt` absent), it should be delivered immediately (or within a short grace window). This requires a startup scan of `scheduled_messages` for past-due entries. The fix is ~20 lines in `daemon.ts` and would make the equity research mission resilient to overnight daemon outages.

---

## Layer 6 — Agent runner / inner loop

| Failure | Effect | Severity | Current mitigation | Gap |
|---------|--------|----------|--------------------|-----|
| LLM rate limit / provider overload | `agent-error` SSE fires with `transient: true`; banner prompts operator | 🟡 | Anthropic SDK retries 2× internally; `agent-error` SSE banner with hint | No automatic re-dispatch after transient error; agent waits for next wakeup |
| LLM auth failure / credits exhausted | `agent-error` SSE fires with `transient: false`; Resume button appears | 🟠 | `agent-error` SSE banner with Resume button | No out-of-band alerting (email, Slack) |
| Context window overflow (>200 k tokens) | Session compaction + reflection runs at session boundary | 🟡 | Sprint 9 reflection system; amber context bar in dashboard; **Sprint 21 mid-session pruning stubs ephemeral tool results + old thinking blocks when context exceeds 160k tokens (80% of window)** | If pruning is insufficient (e.g. a single giant tool result), the next LLM call fails; agent can use `AnalyzeMemories` to recover stubbed content |
| Reflection LLM call fails | Next session starts without updated mental map summary; context grows faster | 🟡 | Non-fatal; session proceeds | Operator sees no indication |
| Conversation write fails mid-session | Partial session in DB; possible replay gap | 🟠 | Atlas HA makes this unlikely | No retry on write failure |
| Statistics write fails (`agentTurnStats` / `missionStats`) | A turn's stats may be stale or missing | 🟡 | `StatsCollector` persist/$inc failures are caught and logged, never thrown into the agent loop — statistics must not break a mission; `llmCallLog` remains the billing source of truth | No retry; affected turn shows degraded stats |
| Daemon hard-killed mid-turn (SIGKILL / OOM) | `agentTurnStats` doc left `status:'running'`; `missionStats` not incremented for that turn | 🟡 | `agentTurnStats` is upserted incrementally (keyed by missionId/agentId/turnNumber, idempotent); `missionStats` is `$inc`-updated only at turn end, so an incomplete turn never contributes → no double-count on the next run. `runAgent`'s `finally` finalizes stats on normal error/abort (status `aborted`). `reconcileStaleRunning()` additionally marks any OTHER `status:'running'` doc for that agent `aborted` the moment its next turn starts (the orchestrator guarantees only one in-flight dispatch per agent, so a stale `running` doc found at that point can only be a crash leftover) | None — closed Sprint 26 |

---

## Layer 7 — Tool system

| Failure | Effect | Severity | Current mitigation | Gap |
|---------|--------|----------|--------------------|-----|
| Tool executor subprocess hangs | Tool call blocks | 🟡 | Per-tool timeout in tool-executor; `MAX_AGENT_RUN_SECONDS` as backstop | None |
| `sudo` permission denied | Tool call fails immediately; error result returned to agent | 🟡 | Agent sees error and can adapt | Symptom of `setup-dev.sh` not run; no clear error to operator |
| Bash command producing infinite output | tool-executor hangs reading stdout | 🟠 | Tool timeout kills subprocess | No alert; `MAX_AGENT_RUN_SECONDS` eventually fires |
| Fly Volume full (see Layer 1) | File writes fail | 🔴 | None | No monitoring |
| ACL broken on workdir | Agent cannot write files | 🟠 | Re-provisioning on daemon restart resets ACLs | Cannot self-heal mid-session |
| Chromium crash (BrowseWeb) | BrowseWeb returns error result | 🟡 | Error result returned to agent; agent can fall back to FetchUrl | None |
| BrowseWeb page hangs | Stagehand `execute` blocks | 🟠 | Playwright default timeouts (~30 s) | `MAX_AGENT_RUN_SECONDS` backstop; Playwright timeouts may not always fire |
| External site unreachable | FetchUrl / SearchWeb / BrowseWeb returns error | 🟡 | Error result to agent | None |

---

## Layer 8 — Background jobs

| Failure | Effect | Severity | Current mitigation | Gap |
|---------|--------|----------|--------------------|-----|
| Daemon restarts while job running | Job process becomes orphaned; `jobs/running/` never cleaned | 🟠 | Orphaned job bounded by its own timeout; `recoverOrphanedJobs()` (now `job-recovery.ts`) scans `jobs/running/` on daemon startup and requeues stale entries to `jobs/pending/` | None — G-6 closed |
| Recovered job's own execution crashes the machine (e.g. OOM) | Without a retry cap, the job is recovered → re-run → crashes again → recovered again on every daemon restart, indefinitely — a real production incident | 🔴 | `MAX_JOB_RECOVERY_ATTEMPTS = 2` in `job-recovery.ts`: after 2 recovery attempts the job is moved to `jobs/failed/`, a failure status is written, and the owning agent (or `"user"` if none) is notified via mailbox instead of being silently requeued forever | None — closed Sprint 26 |
| Job spawns unbounded concurrent subprocesses (e.g. data-factory `refresh.py` fanning out one adapter subprocess per configured data source) | Machine OOMs under peak concurrent subprocess memory, independent of any single job's own timeout | 🔴 | `catalog.cmd_refresh()` bounds adapter fan-out to `DEFAULT_MAX_WORKERS = 5` via `ThreadPoolExecutor`, configurable per mission via `max_parallel_adapters` in `schedule.json` | None — closed Sprint 26. Other background-job scripts that spawn their own subprocess fan-out should apply the same bound; not yet audited repo-wide |
| Job executor crash | Status written to `jobs/status/` as failed | 🟡 | Agent reads status file and handles | None |
| `sharedDir` full | Job output writes fail | 🔴 | None | Same as Fly Volume full |

---

## Layer 9 — Log retention (control-plane daily pruner)

The control-plane scheduler (`scheduler.ts`) runs a daily cron at 02:00 UTC that strips `input`
and `output` from `llmCallLog` entries older than 7 days, keeping usage/cost metadata indefinitely.
The pruner also runs once on control-plane startup to catch any entries missed during downtime.

| Failure | Effect | Severity | Current mitigation | Gap |
|---------|--------|----------|--------------------|-----|
| Control plane down at 02:00 UTC | Pruning skipped for that day; log grows slightly larger | 🟡 | Startup catch-up run fires when control plane restarts | None — catch-up covers missed days |
| Atlas write-blocked (quota exceeded) | `$unset` fails; log cannot be pruned; Atlas blocks writes elsewhere | 🔴 | Must delete documents to free space (Atlas allows deletes when over quota); then fix root cause | Monitor Atlas storage; M2 tier gives 2 GB headroom |
| Pruner crashes mid-run | Partial prune; some old entries retain `input`/`output` | 🟡 | Non-fatal; next scheduled run picks up remaining entries (`$exists` check is idempotent) | None |
| Pruning removes `input`/`output` needed for active debugging | Cannot reconstruct exact LLM call context for old entries | 🟡 | 7-day window covers most debugging scenarios; `usage` metadata always retained | Extend `LOG_RETENTION_DAYS` if a longer window is needed |

---

## Gap summary

| ID | Gap | Severity if triggered | Fix complexity |
|----|-----|----------------------|----------------|
| ~~G-1~~ | ~~No auto-restart policy on Fly execution machine~~ | ~~🟠 Mission stall until operator resumes~~ | **Closed Sprint 20** — `restart: { policy: "on-failure", max_retries: 3 }` added to `fly-machines.ts` |
| G-2 | Inbox messages marked-read before agent completes | 🟠 Inbox text lost (context preserved via mental map) | Moderate — two-phase read/ack in orchestrator |
| G-3 | Missed cron fires not replayed on daemon restart | 🔴 Silently skips daily brief cycle | Moderate — startup catch-up scan in `daemon.ts` |
| G-4 | No disk monitoring for Fly Volume | 🔴 Volume fills silently; writes fail | Moderate — log disk usage in daemon; alert in dashboard |
| G-5 | No out-of-band alerting for LLM auth failure | 🟠 Operator must notice dashboard banner | Moderate — POST to a webhook / send email |
| ~~G-6~~ | ~~Orphaned background jobs not cleaned on restart~~ | ~~🟠 `jobs/running/` accumulates stale entries~~ | **Closed (Sprint 12)** — `recoverOrphanedJobs()` in `daemon.ts` scans on startup |

---

## Operator recovery runbook

### Execution machine stopped (crash / OOM / manual stop)
1. Control plane UI → Mission → **Resume** (or `flyctl machine start <id>`)
2. Open dashboard at `https://magi-control-{suffix}.fly.dev/missions/{id}/dashboard`
3. Verify the dot turns green; thread list repopulates from MongoDB
4. If agents were mid-run when it crashed: send a message to the lead agent — they will re-read their mental map and resume

### Daemon port conflict on restart
```bash
lsof -ti tcp:4000 | xargs kill -9   # clear port 4000
lsof -ti tcp:4001 | xargs kill -9   # clear port 4001
# then restart normally
```

### Extended MongoDB outage
Wait for Atlas to recover, then restart the daemon. All state is in MongoDB; nothing is lost.

### LLM auth failure / credits exhausted
1. Dashboard shows the agent-error banner with a **Resume** button
2. Fix the underlying issue (top up credits, rotate API key)
3. Click **Resume** — this posts a wakeup message to the affected agent
4. The agent will re-read its mental map and continue

### Missed daily brief (daemon was down when cron fired — G-3 unmitigated)
Until G-3 is fixed, manually post a wakeup message to the lead agent:
```bash
MISSION_ID=... npm run cli:post -w packages/agent-runtime-worker -- \
  --to lead "Scheduled wakeup missed — please run today's brief now"
```

### Context window near limit (>75% — amber tab)
Send the lead agent a message asking it to compact its mental map before the next session. The reflection system will handle the rest at the next session boundary.

### Fly Volume full
```bash
flyctl ssh console -a magi-missions-dev -s <machineId>
# Inside the machine:
du -sh /missions/*          # identify largest directories
# Remove old mission workdirs or archive logs
```
