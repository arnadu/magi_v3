# Security Findings Tracker

All known security findings for MAGI V3. Replaces `docs/security-audit-plan.md` (Sprint 12) and
`docs/security-issues.md` (Sprint 4).

**Severity scale:** CRITICAL > HIGH > MEDIUM > LOW  
**Status:** OPEN · FIXED · ACCEPTED · DEFERRED

---

## Open Findings

These require a fix before production deployment.

| ID | Severity | Sprint target | File:Line | Description | Recommended Fix |
|----|----------|--------------|-----------|-------------|-----------------|
| F-018 | LOW | Pre-prod | `packages/control-plane/public/index.html` | **CDN scripts loaded without Subresource Integrity (SRI)** — CoderMirror (jsdelivr), js-yaml (jsdelivr), and Firebase Auth SDK (gstatic.com) are loaded without `integrity` and `crossorigin` attributes. A CDN compromise could inject arbitrary JavaScript. Currently suppressed in SAST with `nosemgrep`. | Add `integrity="sha384-..."` and `crossorigin="anonymous"` to all external `<script>` and `<link>` tags. Compute hashes with `openssl dgst -sha384 -binary <file> \| openssl base64 -A`. Re-compute whenever a CDN dependency version is bumped. |
| F-021 | MEDIUM | Next | `packages/control-plane/src/copilot-tools.ts:577,620,653` | **Copilot's GitHub write tools bypass the `ProposeAction` operator-confirmation flow used by every other copilot write action** — `CreateIssue`, `CloseIssue`, and `AddIssueComment` execute immediately from the LLM's tool call and publish to the public MAGI V3 issue tracker under the project's own identity, with no human review before the content is live. Every comparable-or-lesser-privilege copilot action (`PauseAgent`, `ResumeAgent`, `SetMissionBudget`, `write_mission_file`, `save_template`) requires the operator to `confirm` a `ProposeAction` first. The gap matters because the copilot's context can include content that originated from untrusted external web pages (via `ReadMissionLog`/`ReadMissionMailbox` surfacing FetchUrl/BrowseWeb output already flagged as a prompt-injection surface in TB-8/LLM01) — a successful injection could cause the copilot to post attacker-influenced content publicly with no gate. | Route `CreateIssue`/`CloseIssue`/`AddIssueComment` through the existing `ProposeAction` → operator `confirm` → `executeAction` pattern, same as `write_mission_file`. If the friction is judged not worth it for a solo-operator workflow (CLAUDE.md notes this is intentionally a low-friction bug-tracking aid), downgrade to ACCEPTED with that rationale recorded here rather than leaving it silently ungated. |
| F-022 | LOW | Next | `packages/agent-runtime-worker/src/tools/analyze-memories.ts:29` | **`AnalyzeMemories`'s `query` parameter has no length cap** — `conversation-repository.ts`'s `findRelevant()` correctly escapes regex metacharacters before building the `$regex` filter (no ReDoS), but unlike the equivalent mailbox/conversation search pattern fixed under F-004 (which paired the same escaping with a 200-char cap on the search string), no length limit was carried over here. An arbitrarily long literal-string regex scan across `conversationMessages` is a minor performance concern, not a bypass. | Add the same `.slice(0, 200)`-style cap used by the F-004 fix, applied to `query` before it reaches `findRelevant()`. |
| F-023 | MEDIUM | Sprint 26 | `packages/control-plane/src/mission-copilot-router.ts:92` | **Mission copilot's `ReportGithubIssue` has no operator-confirmation gate** — `POST /github/issue` executes immediately once `verifyMissionToken` passes; there is no `ProposeAction`-equivalent step before the issue goes live on the public tracker. Same root cause and same class as F-021 (control-plane copilot's `CreateIssue`/`CloseIssue`/`AddIssueComment`), now also present on the execution-plane side: the mission copilot's context includes teammates' mental maps/transcripts/mailbox content, any of which may itself carry content ingested from untrusted external sources (TB-8), so a successful injection could cause an attacker-influenced issue to be filed with no human review. Mitigated, not eliminated: 20/min rate limit on `/api/mission-copilot`, forced `mission-copilot` label, server-appended provenance footer naming the mission — none of these are a confirmation gate. | Route through a `ProposeAction`-equivalent flow once either copilot has a confirmable UI surface (cockpit repointing, Sprint 26b+); until then, cross-reference with F-021 rather than resolving independently. |
| F-024 | LOW | Backlog | `packages/control-plane/src/copilot-tools.ts:297` (`ListSchedule`) | **`ListSchedule` has no `userId` scope** — `missionId ? { missionId } : {}` returns every user's scheduled messages when `missionId` is omitted. Same bug class as the five tools fixed under Track 1 of ADR-0016 (GitHub #19), but this one was not in #19's named scope and was intentionally left as a `// TODO` in code rather than silently folded into that fix. | Add `userId` to the query filter, matching the `ReviewObjectives`/`AssessKpi` pattern (`findOne({ missionId, userId })` first, or an equivalent `userId` filter directly on the schedule query). |
| F-025 | LOW | Backlog | `packages/agent-runtime-worker/src/mission-copilot-tools.ts` (`SetMissionSpendCap`) | **Mission copilot can raise its own mission's hard spend cap unconfirmed** — `SetMissionSpendCap` posts an audit-trail mailbox message but has no confirmation gate, and the cap it raises also funds the copilot's own further LLM calls (self-referential). Two options recorded, neither decided in code: (a) accept as the same trust tier as any other unconfirmed mission-agent action, or (b) cap the increase per call (e.g. 2× original) without confirmation. | Decide (a) vs (b) explicitly once real usage data exists; do not resolve silently by picking one in a future refactor without updating this row. |
| F-026 | MEDIUM | Sprint 26 | `packages/agent-runtime-worker/src/mission-copilot-tools.ts` (Family D/E tools) | **Every Family D/E mutating tool except `SaveMissionConfig` has no confirmation gate and no resume-delay grace period** — `EditAgentMentalMap`, `PauseAgent`, `ResumeAgent`, `CreateScheduledMessage`, `CancelScheduledMessage`, `CancelBackgroundJob`, `RestartBackgroundJob`, and `SetMissionSpendCap` (see F-025) are all immediate on call, with a same-turn audit-trail mailbox post as the only check a human gets. Only `SaveMissionConfig` has a built-in grace period (applies on next resume). A compromised mission copilot could, in one turn, pause every teammate, cancel every scheduled review, or kill every background job with no confirmation step at all — the blast radius is whole-team operational disruption, categorically larger than F-023's single unconfirmed external write. Cross-ref F-021/F-023 (same "no confirmable UI surface yet" root cause). | Same resolution path as F-021/F-023 (confirmable UI surface via cockpit repointing); until then, the audit-trail mailbox post is the only mitigation and is documented as such, not silently assumed sufficient. |

---

## Accepted Findings

Accepted as design trade-offs. Re-evaluate before production deployment.

| ID | Severity | File | Description | Rationale |
|----|----------|------|-------------|-----------|
| A-001 | MEDIUM | `workspace-manager.ts` | **sharedDir shared write surface** — all agents in a mission have `rwx` on `sharedDir`, so any agent can overwrite another's output or modify mission skills. | Intentional design: agents collaborate via shared files. The alternative (per-agent skill dirs) defeats the purpose of shared skills. Mitigated by AclPolicy on workdirs. |
| A-002 | LOW | `tools.ts:D1` | **Bash has no software checkPath** — path enforcement for Bash is delegated entirely to OS Linux ACLs, not to `checkPath()`. | Correct by design: Bash runs as the agent's linuxUser and OS ACLs enforce the boundary. A software check would be redundant and bypassable anyway. |
| A-003 | LOW | `tool-api-server.ts` | **MAGI_TOOL_TOKEN appears in job log files** — if a job script runs `env`, the token appears in `logs/bg-<id>.log`. | Token is short-lived (revoked on job exit). Logs are within `sharedDir` (agent-accessible but not externally exposed). No urgent fix. |
| A-004 | INFO | `prompt.ts` | **Mailbox message bodies are injected into agent context unescaped** — a compromised agent can send adversarial instructions to other agents via PostMessage. | Intended mechanism for agent communication. Technical mitigation would break the system. Defended by agent role prompts treating messages as task instructions, not unconditional directives. |
| A-005 | INFO | `daemon.ts:A4` | **Agent can queue a background job via `submit-job.sh`** — job runs as the agent's own linuxUser and receives `MAGI_TOOL_TOKEN`. | The job has the same OS privileges as the agent's Bash tool. The token maps to the agent's own AclPolicy — no escalation beyond what the agent already has. |

---

## Fixed Findings

### Sprint 23

| ID | Severity | Location | Description | Fix applied |
|----|----------|----------|-------------|-------------|
| F-019 | HIGH | `packages/control-plane/src/proxy.ts` | **IDOR — proxy route lacked userId scope** — any authenticated user could proxy into another user's MonitorServer. | `proxy.ts`: `findOne({ missionId, ...ownerFilter })` where `ownerFilter = req.isAdmin ? {} : { userId: req.userId }`. Admin bypass preserved. |
| F-020 | MEDIUM | `packages/control-plane/src/copilot-router.ts` | **Pending action store not userId-scoped** — `confirm` and `dismiss` executed any pending action by UUID with no ownership check. | Added `userId: string` to `PendingAction`; stamped in `ProposeAction` from the copilot daemon's userId; `confirm` and `dismiss` assert `action.userId === req.userId` (or `req.isAdmin`). |
| F-008 | LOW | `packages/agent-runtime-worker/src/monitor-server.ts` | **MonitorServer mutating routes unauthenticated** — no independent token check on `/stop`, `/send-message`, `/extend-budget`, etc. | HMAC-derived per-mission `MONITOR_TOKEN` passed to machine at provision; proxy re-derives and injects `x-monitor-token` header; MonitorServer guards all non-GET routes. `MONITOR_SIGNING_KEY` is control-plane-only Fly secret — never in MongoDB. |
| F-009 | LOW (dev) / HIGH (prod) | `monitor-server.ts:GET /events` | **SSE stream unauthenticated** — any process on the machine (dev) or any authenticated operator (prod via proxy) could read all agent activity including message bodies from the SSE stream. | Sprint 23: `GET /events` on the copilot now requires authentication via `?token=` query param verified by `requireAuth` in the control plane. Mission MonitorServer SSE is behind the TB-9 auth boundary (Firebase JWT / `CONTROL_API_KEY`) via the proxy. Residual gap: `proxy.ts` lacks `userId` scope (F-019), so auth gates entry but does not prevent cross-user SSE access at the proxy level. |
| F-016 | LOW | `packages/control-plane/src/auth.ts` | **No rate limiting on control plane API key auth** — no per-IP request rate limit; brute force of a guessable key feasible. | Sprint 23: `express-rate-limit` (30 req/60 s) applied to `/api/copilot`; `app.set("trust proxy", 1)` ensures client IP is correctly extracted behind Fly.io's TLS termination. Full root-router rate limit remains desirable as defence-in-depth but direct API key brute-force is now significantly harder. |

### Sprint 17

| ID | Severity | Location | Description | Fix applied |
|----|----------|----------|-------------|-------------|
| F-017 | LOW | `tools.ts:verifyIsolation` | **`verifyIsolation()` only checked `ANTHROPIC_API_KEY`** — `OPENROUTER_API_KEY` leak into child process env was not caught by the startup isolation check (primary control — clean-env spawn — was already correct; this was a defense-in-depth gap). | Extended bash probe to test both `ANTHROPIC_API_KEY` and `OPENROUTER_API_KEY`; error message names the specific leaked key(s). |

### Sprint 16

| ID | Severity | Location | Description | Fix applied |
|----|----------|----------|-------------|-------------|
| F-002 | HIGH | `tools/browse-web.ts` | **BrowseWeb post-navigation SSRF** — `stagehand.agent().execute()` can navigate to further URLs (clicks, JS redirects) without SSRF checking. | Added `page.route("**/*", handler)` after `sh.init()` to intercept all document/xhr/fetch resource requests and abort those targeting private hosts. Limitation (accepted): new tab/popup pages opened during agent execution do not inherit the route handler — logged in threat model TB-1. |

### Sprint 4

| ID | Severity | Location | Description | Fix applied |
|----|----------|----------|-------------|-------------|
| S4-C1 | CRITICAL | `tools/fetch-url.ts` | `file://` LFI — agents could read `/proc/self/environ` (API key) via FetchUrl. | Removed `file://` protocol support entirely; tests updated to use local HTTP server. |
| S4-C2 | CRITICAL | `tools.ts` | `checkBashPaths` regex bypassable via base64/eval/heredoc. | Removed `checkBashPaths` entirely; Bash isolation is OS-level only. WriteFile/EditFile retain `checkPath`. |
| S4-H1 | HIGH | `workspace-manager.ts` | Shell injection in `setfacl` calls — `linuxUser` from YAML interpolated into template strings passed to `/bin/sh -c`. | Replaced `execSync(template)` with `execFileSync("setfacl", [...])` (no shell). |
| S4-H2 | HIGH | `tools.ts` | In-process Bash inherited full orchestrator environment including `ANTHROPIC_API_KEY`. | Removed in-process mode entirely; all shell tools always fork via `sudo -u linuxUser` with clean env. Verified by `verifyIsolation()` at daemon startup. |
| S4-M1 | MEDIUM | `tools/fetch-url.ts` | No size cap on HTTP response — arbitrary URL could OOM the orchestrator. | Added 50 MB cap; Content-Length checked before read, byte length after. |
| S4-M2 | MEDIUM | `mailbox.ts` | PostMessage accepted arbitrary recipient IDs with no body size limit. | Recipients validated against team config; body capped at 100 KB. |
| S4-M3 | MEDIUM | `tools.ts` | Bash `timeout` parameter uncapped — agent could pass `timeout: 999999`. | Capped at 600 s (10 min). |
| S4-L1 | LOW | `agent-runner.ts` | Stale comment implied `linuxUser` was optional. | Comment removed. |
| S4-L2 | LOW | `orchestrator.ts` | `?? "agent"` fallback for `role` field violated no-fallbacks principle. | Fallback removed; `role` accessed directly via Zod catchall. |
| S4-L3 | LOW | `tools.ts` | `truncate()` called twice (in `execBash` and in `err()`). | Deduplicated; single call site. |

### Sprint 13

| ID | Severity | Location | Description | Fix applied |
|----|----------|----------|-------------|-------------|
| F-001 | HIGH | `tools/fetch-url.ts` | **FetchUrl SSRF** — no hostname validation allowed fetching cloud metadata or internal services. | Extracted `isPrivateHost()` to shared `src/ssrf.ts`; called before HTTP request and before each image fetch. DNS rebinding protection included. |
| F-003 | MEDIUM | `tools.ts:checkPath` | **Symlink traversal in WriteFile/EditFile** — `resolve()` normalises `..` but does not follow symlinks. | Added `realpathSync()` call after `resolve()`; parent-dir fallback if file does not yet exist. Both resolved and real paths must be within `permittedPaths`. |
| F-004 | MEDIUM | `mailbox.ts:listMessages` | **ReDoS in ListMessages** — `$regex` value was an unescaped LLM-generated string. | Escaped all regex metacharacters with `replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`; capped search string at 200 chars. |
| F-005 | LOW | `daemon.ts:schedule upsert` | **NoSQL injection via schedule label** — non-string label passed to MongoDB filter key. | Added `typeof spec.label !== 'string' \|\| spec.label.length === 0` guard; invalid spec skipped with error log. |
| F-006 | LOW | `daemon.ts:runPendingJobs` | **No wall-clock timeout for background jobs** — hung jobs held concurrency slots indefinitely. | Added `DEFAULT_JOB_TIMEOUT_MS = 30 min`; timer kills entire process group (`process.kill(-pid, 'SIGKILL')`) and revokes token on expiry. |
| F-007 | MEDIUM | `monitor-server.ts:213` | **Monitor server bound to 0.0.0.0** — dashboard reachable on all interfaces. | Changed to `server.listen(port, "127.0.0.1", ...)`; CORS origin tightened from `*` to `http://127.0.0.1`. |
| F-010 | LOW | `daemon.ts:startup` | **Orphaned `jobs/running/` on daemon restart** — stale jobs had no live token, silently failing. | Added `recoverOrphanedJobs()` called at daemon startup; moves running/ entries back to pending/ for retry. |
| F-011 | LOW | `tools.ts:execBash` | **Background processes escaped spawnSync timeout** — SIGKILL only killed direct Bash child. | Replaced `spawnSync` with async `execa` + `detached: true`; timeout handler uses `process.kill(-pid, 'SIGKILL')` to kill entire process group. |
| F-012 | HIGH | `monitor-server.ts:248` | **CORS wildcard allowed cross-origin attacks** — `*` permitted attacker pages to call mutating monitor endpoints. | Replaced `*` with `http://127.0.0.1`; added `Vary: Origin`. |
| F-013 | HIGH | `daemon.ts:runPendingJobs` | **Symlink traversal in background job `scriptPath` validation** — `join()` normalised but did not resolve symlinks, enabling arbitrary code execution. | Added `realpathSync()` call after `resolve()`; real path checked against `permittedPaths` before spawn. |
| F-014 | MEDIUM | `daemon.ts:runPendingJobs` | **`MAGI_TOOL_TOKEN` not revoked if `spawn()` throws** — synchronous throw from spawn left token live until restart. | Token issued inside try block; catch revokes token immediately; `child.on("error", ...)` also revokes. |
| F-015 | LOW | `magi_tool.py:58` | **Python SDK timeout 300 s > server-side timeout 120 s** — client waited 180 s after server gave up. | Changed `timeout=300` to `timeout=135` (server 120 s + 15 s buffer). |

### Sprint 12

| ID | Severity | Location | Description | Fix applied |
|----|----------|----------|-------------|-------------|
| S12-A5 | HIGH | `daemon.ts` / `submit-job.sh` | **`linuxUser` in JobSpec** — agent could write a job spec with a different `linuxUser` to run scripts as another user. | `linuxUser` removed from `JobSpec` entirely; daemon derives it from `agentId` via team config. Unknown `agentId` values are rejected and the spec file is deleted. |
| S12-A6 | HIGH | `daemon.ts:runPendingJobs` | **`scriptPath` not validated** — agent could specify an arbitrary script path outside `permittedPaths`. | `scriptPath` validated against agent's `permittedPaths` (derived from team config) before spawn. Out-of-bounds paths rejected and spec deleted. |
