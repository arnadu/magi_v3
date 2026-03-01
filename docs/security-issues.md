# Security Issues Tracker

All issues found in the Sprint 4 security review. Fix every issue before advancing to Sprint 5.

## Status legend
- ✅ Fixed
- 🔧 In progress
- ⬜ Open

---

## Critical

| ID | Status | Location | Issue |
|----|--------|----------|-------|
| C1 | ✅ Fixed | `tools/fetch-url.ts` | `file://` LFI — agents could read `/proc/self/environ` (API key), other agents' files, `/etc/passwd` via FetchUrl. **Fix:** removed `file://` protocol support entirely; tests updated to use a local HTTP server. |
| C2 | ✅ Fixed | `tools.ts` | `checkBashPaths` regex bypassable via base64/eval/heredoc. **Fix:** removed `checkBashPaths` entirely; Bash isolation is OS-level only (pool user). WriteFile/EditFile retain the sound `checkPath` guard. |

## High

| ID | Status | Location | Issue |
|----|--------|----------|-------|
| H1 | ✅ Fixed | `workspace-manager.ts` | Shell injection in `setfacl` calls — `linuxUser` from YAML was interpolated into template strings passed to `/bin/sh -c`. **Fix:** replaced `execSync(template)` with `execFileSync("setfacl", [...])` (no shell). |
| H2 | ✅ Fixed | `tools.ts` | In-process Bash inherited the full orchestrator environment including `ANTHROPIC_API_KEY`. **Fix:** removed in-process mode entirely; all shell tools always fork a clean child via `sudo -u <linuxUser>` with no secrets in the child environment. |

## Medium

| ID | Status | Location | Issue |
|----|--------|----------|-------|
| M1 | ✅ Fixed | `tools/fetch-url.ts` | No size cap on primary HTTP response — an agent could fetch a multi-GB URL and crash the orchestrator with OOM. **Fix:** added `MAX_RESPONSE_BYTES` (50 MB) cap; Content-Length checked before read, byte length checked after. |
| M2 | ✅ Fixed | `mailbox.ts` | `PostMessage` accepted arbitrary recipient IDs (not validated against team roster) and had no message body size limit. **Fix:** recipients validated against team config; body capped at 100 KB. |
| M3 | ✅ Fixed | `tools.ts` | Bash `timeout` parameter uncapped — agent could pass `timeout: 999999` and block a worker for 277 hours. **Fix:** capped at 600 s (10 min). |

## Low / Informational

| ID | Status | Location | Issue |
|----|--------|----------|-------|
| L1 | ✅ Fixed | `agent-runner.ts` | Stale comment implied `linuxUser` was optional; misleading after Sprint 4 made it required. |
| L2 | ✅ Fixed | `orchestrator.ts` | `?? "agent"` fallback for `role` field violated the no-fallbacks principle; `role` is accessible directly via the Zod catchall type. |
| L3 | ✅ Fixed | `tools.ts` | `execBash` called `truncate()` explicitly then passed to `ok()`/`err()` which also called `truncate()`. **Fix:** truncate moved into `err()` (was missing there) and removed from call sites. |
| L4 | ⬜ Open | `tools.ts` | `spawnSync` timeout kills only the direct Bash child; background processes spawned with `&` escape the timeout. Proper fix requires sending SIGKILL to the process group. Deferred — low exploitability in current deployment model. |

---

## Notes

- **OS-level isolation is the primary enforcement layer for Bash.** The pool user (`magi-w1`, `magi-w2`, …) cannot access other users' files regardless of the command string. `checkBashPaths` was redundant and bypassable — it has been removed.
- **WriteFile and EditFile retain software-level ACL** (`checkPath` against `permittedPaths`) because the path arrives as a structured argument, not embedded in arbitrary shell code. `resolve()` canonicalises the path before the check, making traversal attacks impossible.
- **FetchUrl and InspectImage run in the orchestrator process**, not as the pool user. They must never access arbitrary filesystem paths — hence the `file://` removal and InspectImage's `resolve()`-based allowlist guard.
- **Integration tests now require pool users** (`magi-w1`, `magi-w2`) and `setfacl`. Run `scripts/setup-dev.sh` before `npm run test:integration`.
