# Security Findings Tracker

All known security findings for MAGI V3. Replaces `docs/security-audit-plan.md` (Sprint 12) and
`docs/security-issues.md` (Sprint 4).

**Severity scale:** CRITICAL > HIGH > MEDIUM > LOW  
**Status:** OPEN · FIXED · ACCEPTED · DEFERRED

---

## Open Findings

These require a fix before production deployment. Findings marked `Sprint 13` are targeted for
the current sprint.

| ID | Severity | Sprint target | File:Line | Description | Recommended Fix |
|----|----------|--------------|-----------|-------------|-----------------|
| F-001 | HIGH | 13 | `tools/fetch-url.ts` | **FetchUrl SSRF** — no hostname validation. Agent can fetch `http://169.254.169.254/`, `http://10.0.0.1/`, etc. | Extract `isPrivateHost()` from `browse-web.ts` to shared `src/ssrf.ts`; call it in FetchUrl before making the HTTP request. |
| F-002 | HIGH | 13 | `tools/browse-web.ts` | **BrowseWeb post-navigation SSRF** — initial `page.goto()` is checked, but `stagehand.agent().execute()` can navigate to further URLs (clicks, JS redirects) without checking. | Register `page.route('**', ...)` Playwright interceptor that calls `isPrivateHost()` on every request; abort if private. |
| F-003 | MEDIUM | 13 | `tools.ts:checkPath` | **Symlink traversal in WriteFile/EditFile** — `checkPath()` uses `resolve()` (normalises `..`) but does not call `realpathSync()`. A symlink inside `permittedPaths` pointing to `/etc/passwd` passes the check. | Call `realpathSync()` on the resolved path (or parent dir if file does not yet exist) and verify the real path is also within `permittedPaths`. |
| F-004 | MEDIUM | 13 | `mailbox.ts:listMessages` | **ReDoS in ListMessages** — `opts.search` passed directly as MongoDB `$regex` value. An LLM-generated pathological pattern (e.g. `(a+)+$`) can cause catastrophic backtracking in MongoDB's regex engine. | Escape the search string with `s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` before use; add a length cap (e.g. 200 chars). |
| F-005 | LOW | 13 | `daemon.ts:schedule upsert` | **NoSQL injection via schedule label** — `spec.label` is used as a MongoDB filter key without type validation. If an agent writes `label: { "$gt": "" }`, the upsert matches all existing schedules. | Add `typeof spec.label !== 'string'` guard and reject the spec if it fails. |
| F-006 | LOW | 13 | `daemon.ts:runPendingJobs` | **No wall-clock timeout for background jobs** — a hung job holds a concurrency slot (max 3) and its `MAGI_TOOL_TOKEN` indefinitely. | Add `JobSpec.timeoutMs` (default 30 min); kill child process and revoke token on timeout. |
| F-007 | MEDIUM | 13 | `monitor-server.ts:213` | **Monitor server binds to 0.0.0.0** — port 4000 is reachable on all network interfaces, exposing the unauthenticated dashboard. | Change `server.listen(port, "0.0.0.0", ...)` to `server.listen(port, "127.0.0.1", ...)`. Document SSH tunnel for remote access. |
| F-008 | LOW (dev) / HIGH (prod) | Pre-prod | `monitor-server.ts` | **Unauthenticated control endpoints** — `POST /stop`, `POST /send-message`, `POST /extend-budget` have no auth. Anyone who reaches port 4000 can stop the daemon or inject messages. | Add a shared secret header for all mutating endpoints. Gate check on an `MONITOR_TOKEN` env var; skip if absent (dev mode). |
| F-009 | LOW (dev) / HIGH (prod) | Pre-prod | `monitor-server.ts:GET /events` | **SSE stream exposes all mission data** — if monitor is forwarded to an untrusted network, all agent activity including message bodies is visible. | Addressed by F-007 (localhost binding) for dev; requires auth for production (F-008). |
| F-010 | LOW | Pre-prod | `daemon.ts:startup` | **Orphaned `jobs/running/` on daemon restart** — jobs in `running/` at restart have no token; all `magi-tool` calls fail with 401 silently. | On startup, scan `jobs/running/` and move entries back to `jobs/pending/` (retry) or write `status/<id>.json` with `exitCode: -1, error: "daemon-restarted"`. |
| F-011 | LOW | Deferred | `tools.ts:execBash` | **Background processes escape spawnSync timeout** — SIGKILL sent on timeout kills only the direct Bash child; processes launched with `&` escape the timeout. | Send SIGKILL to the entire process group (negative PID in `process.kill()`). Low exploitability in current deployment. |
| F-012 | HIGH | 13 | `monitor-server.ts:248` | **CORS wildcard enables cross-origin attack** — `Access-Control-Allow-Origin: *` on all responses. Combined with unauthenticated mutating routes (F-008), any cross-origin webpage open in the operator's browser can call `POST /stop`, `POST /send-message`, `POST /extend-budget`. Even after F-008 is fixed with a shared-secret header, wildcard CORS lets an attacker-controlled page extract the secret from the DOM and replay it. | Replace `*` with `http://localhost:${port}` (or remove the header entirely). Add `Vary: Origin`. |
| F-013 | HIGH | 13 | `daemon.ts:283-284` | **Symlink traversal in background job `scriptPath` validation** — `runPendingJobs()` uses `join()` to normalise `scriptPath` before the `startsWith(permittedPath)` check, but `join()` does not resolve symlinks. An agent with write access to `sharedDir/jobs/pending/` can create a symlink pointing to an arbitrary executable; the path check passes but the OS follows the symlink at execution time. Same class as F-003 but in the job execution path — higher impact because it results in arbitrary code execution rather than a file read/write. | Replace `join(spec.scriptPath)` with `realpathSync(spec.scriptPath)` (handle `ENOENT`) before the `permittedPaths` check. |
| F-014 | MEDIUM | 13 | `daemon.ts:304,311,329` | **`MAGI_TOOL_TOKEN` not revoked if `spawn()` throws** — token is issued at line 304 before `child_process.spawn()` at line 311; revocation is only registered in the `child.on("close", ...)` handler. If `spawn()` throws synchronously (executable not found, permission denied), the `close` event never fires and the token remains valid until daemon restart. | Add `child.on("error", () => toolApiServer.revokeToken(token))` immediately after spawn; wrap the spawn call in try/catch to revoke on synchronous throw. |
| F-015 | LOW | 13 | `magi_tool.py:58` | **Python SDK timeout (300 s) exceeds server-side timeout (120 s)** — when the ToolApiServer aborts a tool call at 120 s and returns 504, the Python client waits a further 180 s before timing out, holding a daemon concurrency slot and leaving scripts hung. | Set `timeout=135` in `magi_tool.py` (server timeout + 15 s buffer). |

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

### Sprint 12

| ID | Severity | Location | Description | Fix applied |
|----|----------|----------|-------------|-------------|
| S12-A5 | HIGH | `daemon.ts` / `submit-job.sh` | **`linuxUser` in JobSpec** — agent could write a job spec with a different `linuxUser` to run scripts as another user. | `linuxUser` removed from `JobSpec` entirely; daemon derives it from `agentId` via team config. Unknown `agentId` values are rejected and the spec file is deleted. |
| S12-A6 | HIGH | `daemon.ts:runPendingJobs` | **`scriptPath` not validated** — agent could specify an arbitrary script path outside `permittedPaths`. | `scriptPath` validated against agent's `permittedPaths` (derived from team config) before spawn. Out-of-bounds paths rejected and spec deleted. |
