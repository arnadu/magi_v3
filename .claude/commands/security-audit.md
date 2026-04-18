---
allowed-tools: Read, Glob, Grep, LS, Task, Edit, Write
description: Periodic deep security audit — boundary-by-boundary verification of all threat model mitigations
---

You are a senior security engineer conducting a comprehensive security audit of the MAGI V3
codebase. Unlike a sprint review (which only looks at changes), this audit covers the full
implementation of every trust boundary.

THREAT MODEL AND KNOWN FINDINGS (read first):

```
!`cat docs/security/threat-model.md`
```

```
!`cat docs/security/findings.md`
```

---

AUDIT METHODOLOGY:

This audit is driven by the threat model above. For each trust boundary (TB-1 through TB-8):
1. Read every file listed in the "Implementing Files by Boundary" section for that boundary
2. For each STRIDE row marked ✅: verify the mitigation is actually present in the code as described
3. For each STRIDE row marked ~: assess how partial the mitigation is; identify what would complete it
4. For each STRIDE row marked ⚠️: confirm the vulnerability is still open (or flag if it has been fixed and findings.md needs updating)
5. Identify any new threats in those files not yet captured in the threat model

Then for each OWASP LLM item:
1. Read the key files listed for that item
2. Assess whether the described threat is present and whether any mitigations exist in code

IMPORTANT:
- Do NOT re-report findings already in findings.md as OPEN unless you have new evidence about them
- DO flag if a finding marked ⚠️ has actually been fixed (so findings.md can be updated)
- DO flag if a mitigation marked ✅ is not actually present in the current code

---

EXECUTION PLAN:

Run the following as parallel sub-tasks (one per trust boundary + one for OWASP). Each sub-task
should read its assigned files and produce a structured analysis.

**Sub-task TB-1 — External HTTP requests:**
Read these files fully:
- packages/agent-runtime-worker/src/tools/fetch-url.ts
- packages/agent-runtime-worker/src/tools/browse-web.ts
- packages/agent-runtime-worker/src/tools/research.ts
- packages/agent-runtime-worker/src/tools/search-web.ts
- packages/agent-runtime-worker/src/models.ts

Check: (1) Does FetchUrl call `isPrivateHost()` before making the HTTP request? (F-001)
(2) Does BrowseWeb have a `page.route()` interceptor for all requests, not just the initial goto? (F-002)
(3) Is `PRIVATE_HOST_RE` / `isPrivateHost()` defined in one shared place or duplicated?
(4) Is the `file://` protocol rejected in FetchUrl?
(5) Are response sizes capped?
(6) Does `parseModel()` in models.ts route non-Anthropic model IDs to OpenRouter? Is `OPENROUTER_API_KEY` kept out of child process envs (tool-executor, magi-job)? Does `verifyIsolation()` check for it?
(7) Are there any new HTTP call sites not in the threat model?

**Sub-task TB-2 — Monitor server:**
Read: packages/agent-runtime-worker/src/monitor-server.ts

Check: (1) Does `server.listen()` bind to `127.0.0.1` or `0.0.0.0`? (F-007)
(2) Do `POST /stop`, `POST /send-message`, `POST /extend-budget` have any authentication? (F-008)
(3) Does the SSE stream at `GET /events` expose sensitive data?
(4) Are there any new routes since the last audit?

**Sub-task TB-3 — tool-executor subprocess:**
Read: packages/agent-runtime-worker/src/tools.ts
Read: packages/agent-runtime-worker/src/tool-executor.ts

Check: (1) Does `checkPath()` call `realpathSync()` after `resolve()` before the permittedPaths check? (F-003)
(2) Is the child process env genuinely clean (only PATH + HOME)?
(3) Does `verifyIsolation()` run at daemon startup?
(4) Is the Bash timeout capped at 600s?
(5) Are `setfacl` calls using `execFileSync` (not shell string interpolation)?

**Sub-task TB-4 — magi-job subprocess:**
Read: packages/agent-runtime-worker/src/daemon.ts (focus: runPendingJobs, startScheduledDelivery)
Read: scripts/setup-dev.sh (focus: magi-job wrapper, sudoers section)

Check: (1) Is `linuxUser` absent from `JobSpec`? Is it derived from `agentId` via team config?
(2) Is `scriptPath` validated against `permittedPaths` before spawn? Does validation use `realpathSync()` (not just `join()`) to prevent symlink traversal? (F-013)
(3) Is `MAGI_TOOL_TOKEN` revoked in ALL exit paths (normal close, error, spawn failure)? Is there a try/catch around `spawn()` that revokes on synchronous throw? (F-014)
(4) Is there a wall-clock timeout for hung jobs? (F-006)
(5) On daemon startup, are orphaned `jobs/running/` entries recovered? (F-010)
(6) Does the `magi-job` wrapper use `exec "$@"` at a fixed path? Is it the only sudo entry for arbitrary script execution?
(7) Does `env_keep` apply only to the `magi-job` path (`Defaults!<cmd>`), not globally?

**Sub-task TB-5 — ToolApiServer:**
Read: packages/agent-runtime-worker/src/tool-api-server.ts
Read: packages/agent-runtime-worker/src/cli-tool.ts
Read: packages/skills/run-background/scripts/magi_tool.py

Check: (1) Does the server bind to `127.0.0.1` only?
(2) Does every request validate the bearer token before dispatching to the tool?
(3) Is the token map properly scoped (token → AclPolicy, not token → linuxUser)?
(4) Is there a per-call timeout on tool dispatch?
(5) Does the CLI and Python SDK always send the token via `Authorization: Bearer`, not in a query param or body?

**Sub-task TB-6 — AclPolicy enforcement:**
Read: packages/agent-runtime-worker/src/tools.ts (focus: checkPath, PolicyViolationError, tool factories)
Read: packages/agent-runtime-worker/src/agent-runner.ts (focus: tool registration, researchAcl)

Check: (1) Do WriteFile and EditFile both call `checkPath()`? Does Bash intentionally skip it?
(2) Is `researchAcl` restricted to `sharedDir` only (not agent workdir)?
(3) Is `PolicyViolationError` the only error type that bypasses tool retries?
(4) Is `maxTurns` enforced in the Research sub-loop?

**Sub-task TB-7 — sharedDir shared write surface:**
Read: packages/agent-runtime-worker/src/workspace-manager.ts
Read: packages/agent-runtime-worker/src/skills.ts
Read: packages/agent-runtime-worker/src/daemon.ts (focus: scheduled message upsert, spec.label)

Check: (1) Is `spec.label` type-validated as a string before use in the MongoDB upsert filter? (F-005)
(2) Does `discoverSkills()` truncate or sanitize SKILL.md `description` fields before injecting into the system prompt?
(3) Are `setfacl` permissions correctly applied: `r-x` on `_platform/` and `_team/`, `rwx` on `mission/`?
(4) Is `git init` idempotent (only runs if `.git` does not yet exist)?

**Sub-task TB-8 — Untrusted content → agent context:**
Read: packages/agent-runtime-worker/src/prompt.ts
Read: packages/agent-runtime-worker/src/mental-map.ts
Read: packages/agent-runtime-worker/src/reflection.ts
Read: packages/agent-runtime-worker/src/mailbox.ts

Check: (1) Is `opts.search` in `listMessages` escaped before use as `$regex`? (F-004)
(2) Does `patchMentalMap()` constrain writes to existing `<section id="...">` elements, or can new elements be inserted?
(3) Does `buildSystemPrompt()` inject the mental map HTML unescaped into the system prompt? If so, what is the scope of what the agent can write there?
(4) Are BrowseWeb trust boundary markers present in all code paths (including `agent().execute()` results)?
(5) Does `formatMessages()` apply any sanitization to mailbox body content before injecting into user turns?

**Sub-task OWASP — LLM-specific threats:**
Read: packages/agent-runtime-worker/src/agent-runner.ts
Read: packages/agent-runtime-worker/src/prompt.ts
Read: packages/agent-runtime-worker/src/tools/browse-web.ts (trust boundary markers)
Read: packages/agent-runtime-worker/src/mailbox.ts (PostMessage recipient validation)

Check each OWASP LLM item in the threat model:
(1) LLM01 Prompt Injection: are trust boundary markers present in all tool results that return external content?
(2) LLM02 Insecure Output Handling: what validates LLM output before it drives privileged operations?
(3) LLM06/07 Information Disclosure / Prompt Leakage: can an agent send its system prompt to an external address?
(4) LLM08 Excessive Agency: what caps exist on per-session action count or total tool calls?
(5) LLM09 Overreliance: is there any enforcement of catalog status checks in data factory consumer scripts?

---

CONSOLIDATION:

After all sub-tasks complete, produce a single report with two sections:

### 1. Mitigation Verification Summary

A table showing the current status of each ✅ entry in the STRIDE and OWASP tables:

| Boundary | Threat (brief) | Claimed status | Verified? | Notes |
|----------|---------------|----------------|-----------|-------|
| TB-3 | API key in child env | ✅ | YES / NO / PARTIAL | ... |
| ... | | | | |

Mark as:
- **CONFIRMED** — mitigation is present exactly as described
- **PARTIAL** — mitigation exists but has gaps (describe)
- **NOT FOUND** — no evidence of the mitigation in current code (raise as a new finding)
- **STALE** — finding marked ⚠️ appears to have been fixed; findings.md should be updated

### 2. New Findings

For any new vulnerabilities discovered (not already in findings.md), use the standard format:

## F-NNN: <short title>
- **Severity**: HIGH / MEDIUM / LOW
- **Boundary**: TB-N
- **File:Line**: path/to/file.ts:NN
- **Category**: ssrf / path-traversal / nosql-injection / privilege-escalation / prompt-injection / etc.
- **Description**: one paragraph
- **Exploit scenario**: concrete, specific attack path
- **Recommended fix**: specific code change
- **Confidence**: N/10 (only report if ≥ 8)

If no new findings: output `No new findings.`

### 3. Threat Model Update Recommendations

List any threats you observed that are not captured in the current STRIDE or OWASP tables —
new attack surfaces, new data flows, or mitigations that have drifted from what the model describes.
Format as bullet points with the suggested table row addition.

---

WRITE STEP (execute after consolidation, before producing the report):

**New findings** — write any finding from Section 2 (confidence ≥ 8) to findings.md:
1. Read `docs/security/findings.md` and find the last `| F-NNN |` row in the Open Findings table
2. For each finding, insert a new row using the Edit tool, immediately before the `---` that
   separates Open Findings from Accepted Findings:
   ```
   | F-NNN | SEVERITY | Next | `file:line` | **Title** — one-sentence description | Recommended fix |
   ```

**NOT FOUND mitigations** — any ✅ entry in Section 1 marked NOT FOUND means the claimed
mitigation is absent from the code. Treat it as a new finding with severity matching the
original STRIDE threat category, and write it to findings.md using the same process.

**STALE findings** — any ⚠️ finding in Section 1 that appears to be fixed: do NOT
automatically close it. Note it in the report as `[STALE — confirm and close manually]`
so the operator can add the fix description and move it to Fixed Findings.

At the end of the report, append:
**Findings written to findings.md:** F-NNN, F-NNN+1, … (or "None")
**Stale findings to review:** F-NNN (appears fixed), … (or "None")
