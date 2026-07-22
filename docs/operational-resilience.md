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
| Persisted `missionAnomalies` log + `AnomalyRecorder` (`anomaly.ts`) unifying limit breaches, agent crashes/timeouts, LLM errors, permanently-failed jobs/scheduled deliveries, and unclean restarts into one sink that notifies the mission copilot and (hard-severity only) relays to the owning user's control-plane copilot via `copilot-{userId}`, replacing a `COPILOT_MISSION_ID` env var never actually set on execution-plane machines | 26c | Several failure categories had no automated wake-up trigger at all (LLM completion errors were SSE-only, invisible to either copilot); the control-plane copilot's relay path was dead code in production and, had it ever been enabled, would have routed every mission's alerts into one shared "copilot" mailbox regardless of which user owned the mission — a latent cross-user leak risk. See ADR-0020 |
| `WorkspaceManager`'s `copyTeamFilesToSharedDir` now seeds `sharedDir/objectives/*` only when the file doesn't already exist on disk — never overwrites an existing one | 26b | Every mission resume reruns `provision()` (resume deletes and recreates the machine), which unconditionally overwrote the Fly volume's evolved objectives with whatever stale snapshot happened to be in MongoDB's `teamFiles` — silently reverting real progress. Found live on `gold-digest-v2-20260628-1451`; root-caused via direct `git log` inspection of the mission's own workspace after the mission copilot's self-report misattributed the mechanism to an agent's write. Interim fix only — the underlying two-copy architecture (volume + Mongo snapshot) remains; full removal proposed in ADR-0019, targeted Sprint 26c |
| `mission-config.ts`'s `MissionConfigRepository` reads `agent.limits`/`mission.maxCostUsd` fresh from `teamConfigYaml` at the same point `enforceLimits`/the mission-cap check already read `missionStats`; `/set-budget`/`/extend-budget` now persist to MongoDB instead of only mutating in-memory `currentCapUsd` | 26b | Per-agent limit edits only took effect on the mission's next resume (`teamConfig` loaded once at daemon boot, never re-read); the mission copilot's `SetMissionSpendCap` tool called `/set-budget`, which never wrote to Mongo at all — a copilot-set cap was invisible to the cockpit and lost on restart. See ADR-0018 |
| Removed `StatsCollector`'s in-memory lifetime-cost cache entirely; every cost verification (mission-wide spend cap, per-agent `maxLifetimeCostUsd`, cost-attribution) reads `missionStats` fresh from MongoDB at decision time (`StatsCollector.readLifetime()` / `readMissionSnapshot()`); reflection call cost (previously excluded from `missionStats` entirely) now recorded via `recordReflectionCost()` | 26b | The mission-wide spend cap and dashboard total were read from `UsageAccumulator`, an in-memory, session-only counter that resets to $0 on every daemon restart — found live when a mission's Limits panel showed "$7.52 / $60.00" spent against a real persisted total of $60.26. Two earlier fix drafts (better hydration, wider-scoped cache) were rejected in design review for preserving the same cache-can-drift bug class; the final design eliminates the cache instead — LLM-call latency (seconds) dwarfs an indexed Mongo read (low single-digit ms), so there is no real performance case for caching verification-critical data. See `agent-stats.ts`'s header comment for the full rationale |
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
| Mission resume (deletes + recreates the machine, same volume reattached) races `sharedDir/objectives/*`'s two-copy state | Volume has the real, evolved objectives; `provision()` reruns on every resume and used to unconditionally overwrite them from MongoDB's `teamFiles` snapshot — silently reverting real progress | 🔴 | `copyTeamFilesToSharedDir` now seeds `objectives/*` only if missing on disk, never overwrites an existing file there (interim fix, this sprint) | G-7 — full fix (remove the two-copy architecture) is ADR-0019, targeted Sprint 26c |
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
| Crash (unhandled exception) | All agent runs terminate; PID file left on disk | 🟠 | Next start auto-detects stale PID via `process.kill(pid, 0)`; MongoDB state intact; **an `unclean-restart` (soft) anomaly is recorded and mailed to the mission copilot (ADR-0020)** | No auto-restart (see G-1) |
| SIGKILL / OOM kill | Same; `finally` blocks do not run | 🟠 | Stale PID auto-detected; MongoDB write atomicity protects data; same `unclean-restart` anomaly as above — a coarse "the process died abnormally" signal, not attribution (can't distinguish this from the row above without polling the Fly Machines API, deliberately out of scope) | None |
| Graceful SIGTERM | Abort signal fires; orchestrator waits for active agents to finish their current tool call; PID file removed | 🟠 | Full graceful shutdown path | None |
| Second SIGINT (force-exit) | Hard exit; PID file not removed | 🟠 | Intentional; stale PID auto-detected on next start | None |
| Port 4000 / 4001 conflict on restart | Monitor / tool server fails to bind; daemon startup fails | 🟠 | PID check prevents two instances of same mission | Race window between hard kill and port release; `lsof -ti tcp:4000 \| xargs kill -9` resolves it |
| Team config edited while the mission is running via `SaveMissionConfig` or control-plane `PUT /:id/config` (full config replace — prompts, `initialMentalMap`, agent roster, etc.) | Persisted correctly, but silently has no effect on the running process — `daemon.ts` reads `TEAM_CONFIG` once at boot and never re-reads it | 🟡 | Posts a mailbox message stating the change "takes effect the next time the mission is resumed, not immediately" | No live config re-read for non-limits fields; an operator who doesn't read the confirmation message may assume an edit is already active |
| Cockpit Limits panel's `PATCH /:id/limits/*` routes (mission cap, per-agent hard/soft limits) | **No longer a gap (ADR-0018)** — both apply live | 🟢 | `agent-runner.ts`'s `enforceLimits` and `daemon.ts`'s mission-cap check read `agent.limits`/`mission.maxCostUsd` fresh from `teamConfigYaml` on every check via `MissionConfigRepository`, independent of the boot-time `teamConfig` snapshot; the mission-cap route additionally calls the running mission's `/set-budget` to wake an already-paused mission immediately | None — closed Sprint 26b |

**Recovery — stale daemon:**  
The daemon startup checks whether the PID in `daemon.pid` is alive (`process.kill(pid, 0)`). If the process is gone, the stale file is overwritten and startup proceeds normally. No operator action is needed beyond starting the daemon.

---

## Layer 4 — Orchestration loop

| Failure | Effect | Severity | Current mitigation | Gap |
|---------|--------|----------|--------------------|-----|
| Agent hung indefinitely | Agent occupies `active` map forever; loop freezes | 🟡 | `MAX_AGENT_RUN_SECONDS` (default 4 h) aborts dispatch via AbortSignal; `agent-error` SSE fires; **an `agent-timeout` anomaly is recorded (`missionAnomalies`) and mailed to the mission copilot, relayed to the control-plane copilot as hard-severity (ADR-0020)** | 4-hour window may be long for production monitoring; lower with `MAX_AGENT_RUN_SECONDS` env var |
| LLM completion call stalls mid-stream (provider hangs, not a rate limit) | Previously: turn stuck at `status:'running'` until the 4 h dispatch backstop fired — reported as "hung" while nothing was happening | 🟡 | `deriveDeadline()` in `loop.ts` gives each individual completion call its own cancelling deadline (default 8 min, `llmCallTimeoutMs`), threaded through nested sub-loops (e.g. Research tool); `lastCallAborted` is checked in `agent-runner.ts`'s `finally` so the turn is correctly marked `aborted`, not silently left `running` | None — closed Sprint 26 |
| `maxRuns` cap reached | No further dispatches; daemon waits for mail indefinitely | 🟠 | Dashboard shows idle; operator can still send messages | No alert when cap is hit; operator must notice the idle state |
| `waitForBudget` with dashboard unreachable | Orchestrator blocks forever waiting for budget extension | 🟠 | Every cap check (`onAgentMessage` in `daemon.ts`, `/set-budget`'s un-pause decision in `monitor-server.ts`) reads mission cost fresh from `missionStats` via `StatsCollector.readMissionSnapshot()` — no in-memory cache to go stale across a restart, so the pause/resume decision is always correct even after the daemon restarts mid-pause | None |
| `waitForMail` never resolves (no new mail) | Orchestrator blocks correctly — this is normal daemon idle state | 🟡 | Intended behavior | None |

---

## Layer 5 — Scheduled messages

The daily brief, weekly report, and event-alert wakeups depend on scheduled-message delivery
happening at the right time.

**Correction (2026-07-22, ADR-0020): this section previously described an execution-plane,
in-memory `node-cron` design and a corresponding "G-3: missed cron fires are not replayed" gap.
That's no longer how this works — scheduling moved to the always-on control plane
(`packages/control-plane/src/scheduler.ts`) at some point before this correction was written,
and the doc was never updated. The real design and its real (narrower) gap are below.**

Delivery runs on the **control plane**, not inside any mission's execution-plane daemon: a
`node-cron` heartbeat ticks every minute, atomically claims any `scheduled_messages` doc with
`status: "pending"` and `deliverAt <= now`, resumes the mission's machine if it's stopped, and
inserts the message directly into `mailbox`. It also runs once immediately on control-plane
startup. Because the control plane is always-on (unlike execution-plane machines, which are
on-demand), a message that comes due while nothing was polling simply gets picked up by the very
next minute's tick or the startup catch-up run — there is no window where a fire is silently
missed the way there would be if this lived in a per-mission, on-demand process.

| Failure | Effect | Severity | Current mitigation | Gap |
|---------|--------|----------|--------------------|-----|
| Control plane down when a message comes due | Delivery delayed until the control plane is back up | 🟡 | Startup catch-up tick (`deliver(db)` runs immediately on `startScheduler()`) picks up anything overdue | None — the always-on-process design itself is the mitigation |
| Mailbox insert or machine-resume fails (transient) | Delivery attempt fails | 🟡 | Retried on the next minute's tick, up to `MAX_DELIVERY_ATTEMPTS = 5` (`deliveryAttempts` counter on the doc, mirrors `MAX_JOB_RECOVERY_ATTEMPTS`'s reasoning) | None — closed as part of ADR-0020 |
| Delivery keeps failing past the cap (e.g. the mission's machine or `missionId` no longer exists) | Previously: reopened to `"pending"` and retried forever, indefinitely, with no visibility | 🔴 | Marked `status: "failed"` past `MAX_DELIVERY_ATTEMPTS`; a `scheduling-failure` anomaly is recorded (`missionAnomalies`) and mailed to the mission copilot, relayed to the control-plane copilot as hard-severity (ADR-0020) | None — closed Sprint 26c |
| `cancelSchedule` called concurrently with delivery | Document deleted; message not delivered | 🟡 | Low probability race; `deleteOne` is atomic | None |

---

## Layer 6 — Agent runner / inner loop

| Failure | Effect | Severity | Current mitigation | Gap |
|---------|--------|----------|--------------------|-----|
| LLM rate limit / provider overload | `agent-error` SSE fires with `transient: true`; banner prompts operator | 🟡 | Anthropic SDK retries 2× internally; `agent-error` SSE banner with hint; **an `llm-error` (soft) anomaly is recorded and mailed to the mission copilot (ADR-0020)** — previously this signal was SSE-only, invisible to either copilot | No automatic re-dispatch after transient error; agent waits for next wakeup |
| LLM auth failure / credits exhausted | `agent-error` SSE fires with `transient: false`; Resume button appears | 🟠 | `agent-error` SSE banner with Resume button; **an `llm-error` (hard) anomaly is recorded and relayed to the control-plane copilot (ADR-0020)** | No out-of-band alerting (email, Slack) — still G-5, the copilot now knows, the operator may still not until they check the dashboard |
| Context window overflow (>200 k tokens) | Session compaction + reflection runs at session boundary | 🟡 | Sprint 9 reflection system; amber context bar in dashboard; **Sprint 21 mid-session pruning stubs ephemeral tool results + old thinking blocks when context exceeds 160k tokens (80% of window)** | If pruning is insufficient (e.g. a single giant tool result), the next LLM call fails; agent can use `AnalyzeMemories` to recover stubbed content |
| Reflection LLM call fails | Next session starts without updated mental map summary; context grows faster | 🟡 | Non-fatal; session proceeds | Operator sees no indication |
| Conversation write fails mid-session | Partial session in DB; possible replay gap | 🟠 | Atlas HA makes this unlikely | No retry on write failure |
| Statistics write fails (`agentTurnStats` / `missionStats`) | A turn's stats may be stale or missing | 🟡 | `StatsCollector` persist/$inc failures are caught and logged, never thrown into the agent loop — statistics must not break a mission; `llmCallLog` remains the billing source of truth | No retry; affected turn shows degraded stats |
| Statistics read fails (`readLifetime()` / `readMissionSnapshot()` — every limit check and the mission-wide cap now hit MongoDB directly, no cache) | A limit check or the dashboard total sees stale/absent data for that one read | 🟡 | These reads are on the hot path (every LLM call / tool result) but each is a single indexed query against a small collection — added latency is negligible next to LLM call latency; a transient Mongo hiccup self-heals on the next call since nothing is cached to lock in a stale value | No retry on a single failed read; a limit check silently no-ops for that one call if the read throws (caught, logged, not re-checked until the next call) |
| Limit *configuration* read fails (`MissionConfigRepository.readTeamConfig()` — `enforceLimits` and the daemon's mission-cap check now also hit MongoDB's `teamConfigYaml` fresh on every call, ADR-0018) | A limit check for that one call uses a possibly-outdated threshold | 🟡 | Falls back to the boot-time `teamConfig` snapshot on a failed read — a strictly safer degrade than the stats-read row above, since a last-known-good config is available for free rather than skipping the check entirely | No retry on a single failed read; re-attempted on the next call regardless |
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
| Recovered job's own execution crashes the machine (e.g. OOM) | Without a retry cap, the job is recovered → re-run → crashes again → recovered again on every daemon restart, indefinitely — a real production incident | 🔴 | `MAX_JOB_RECOVERY_ATTEMPTS = 2` in `job-recovery.ts`: after 2 recovery attempts the job is moved to `jobs/failed/`, a failure status is written, and the owning agent (or `"user"` if none) is notified via mailbox instead of being silently requeued forever; **a `job-failure` (hard) anomaly is also recorded so it's visible mission-wide, not just to whoever the job happened to notify (ADR-0020)** | None — closed Sprint 26 |
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
| ~~G-3~~ | ~~Missed cron fires not replayed on daemon restart~~ | ~~🔴 Silently skips daily brief cycle~~ | **Corrected, not a real gap (2026-07-22)** — this described an execution-plane in-memory `node-cron` design that no longer matches the code; delivery is control-plane-owned, always-on, with a startup catch-up tick already in place. The real (narrower) gap it was standing in for — no attempt cap on repeated delivery failure — closed Sprint 26c via `MAX_DELIVERY_ATTEMPTS` in `scheduler.ts` (ADR-0020) |
| G-4 | No disk monitoring for Fly Volume | 🔴 Volume fills silently; writes fail | Moderate — log disk usage in daemon; alert in dashboard |
| G-5 | No out-of-band alerting for LLM auth failure | 🟠 Operator must notice dashboard banner | Moderate — POST to a webhook / send email |
| ~~G-6~~ | ~~Orphaned background jobs not cleaned on restart~~ | ~~🟠 `jobs/running/` accumulates stale entries~~ | **Closed (Sprint 12)** — `recoverOrphanedJobs()` in `daemon.ts` scans on startup |
| G-7 | `sharedDir/objectives/*`'s two-copy architecture (Fly volume + MongoDB `teamFiles` snapshot) — interim fix (seed-if-missing) closes the acute resume-overwrite symptom, but there is still no single source of truth; the Mongo snapshot remains a permanently-inert copy that could mislead a future feature into treating it as current | 🔴 Data loss (mitigated, not eliminated, by the interim fix) | Substantial — full removal is a real migration (objectives → MongoDB, tools replace the Bash-script skill); see ADR-0019 / issue #23, targeted Sprint 26c |

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
