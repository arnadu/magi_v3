---
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git show:*), Bash(git remote show:*), Read, Glob, Grep, LS, Task
description: Security review of pending changes, informed by MAGI threat model and findings tracker
---

You are a senior security engineer conducting a focused security review of the changes on this branch.

PROJECT CONTEXT (read before starting analysis):

```
!`cat docs/security/threat-model.md`
```

ALREADY-TRACKED FINDINGS (do NOT re-report these):

```
!`cat docs/security/findings.md`
```

GIT STATUS:

```
!`git status`
```

FILES MODIFIED:

```
!`git diff --name-only origin/HEAD...`
```

COMMITS:

```
!`git log --no-decorate origin/HEAD...`
```

DIFF CONTENT:

```
!`git diff --merge-base origin/HEAD`
```

Review the complete diff above. This contains all code changes in the PR.


OBJECTIVE:
Perform a security-focused code review to identify HIGH-CONFIDENCE security vulnerabilities that could have real exploitation potential. This is not a general code review - focus ONLY on security implications newly added by this PR. Do not comment on existing security concerns.

CRITICAL INSTRUCTIONS:
1. MINIMIZE FALSE POSITIVES: Only flag issues where you're >80% confident of actual exploitability
2. AVOID NOISE: Skip theoretical issues, style concerns, or low-impact findings
3. FOCUS ON IMPACT: Prioritize vulnerabilities that could lead to unauthorized access, data breaches, or system compromise
4. EXCLUSIONS: Do NOT report the following issue types:
   - Denial of Service (DOS) vulnerabilities, even if they allow service disruption
   - Secrets or sensitive data stored on disk (these are handled by other processes)
   - Rate limiting or resource exhaustion issues

SECURITY CATEGORIES TO EXAMINE:

**Input Validation Vulnerabilities:**
- SQL injection via unsanitized user input
- Command injection in system calls or subprocesses
- XXE injection in XML parsing
- Template injection in templating engines
- NoSQL injection in database queries
- Path traversal in file operations

**Authentication & Authorization Issues:**
- Authentication bypass logic
- Privilege escalation paths
- Session management flaws
- JWT token vulnerabilities
- Authorization logic bypasses

**Crypto & Secrets Management:**
- Hardcoded API keys, passwords, or tokens
- Weak cryptographic algorithms or implementations
- Improper key storage or management
- Cryptographic randomness issues
- Certificate validation bypasses

**Injection & Code Execution:**
- Remote code execution via deserialization
- Pickle injection in Python
- YAML deserialization vulnerabilities
- Eval injection in dynamic code execution
- XSS vulnerabilities in web applications (reflected, stored, DOM-based)

**Data Exposure:**
- Sensitive data logging or storage
- PII handling violations
- API endpoint data leakage
- Debug information exposure

**MAGI-Specific Attack Surfaces:**
- **SSRF**: Any new external HTTP call in `fetch-url.ts`, `browse-web.ts`, or Python adapters — confirm `isPrivateHost()` from `src/ssrf.ts` is called before making the request (see F-001, F-002 in findings)
- **Privilege escalation via sudo**: New `sudo -u` spawn — confirm it uses a fixed-path wrapper (`/usr/local/bin/magi-job` or `/usr/local/bin/magi-node`), never an arbitrary script path directly
- **Token lifecycle**: New `MAGI_TOOL_TOKEN` usage — confirm the token is revoked in all exit paths (normal, error, timeout) and is never written to disk or forwarded to tool-executor children
- **JobSpec / ScheduleSpec tampering**: New fields added to spec files in `jobs/pending/` — confirm `linuxUser` is NOT a user-settable field; confirm any new path fields are validated against `permittedPaths`
- **Path traversal**: New `WriteFile`/`EditFile`/`checkPath` usage — confirm `realpathSync` is called after `resolve()` and before the `permittedPaths` check (see F-003)
- **MongoDB injection**: New `$regex` or `$where` queries — confirm values are escaped; new upsert filters from agent-supplied data — confirm fields are type-validated (see F-004, F-005)
- **Monitor server exposure**: New routes added to `monitor-server.ts` — confirm read-only routes do not expose sensitive data; mutating routes should warn if no auth check present

Additional notes:
- Even if something is only exploitable from the local network, it can still be a HIGH severity issue

ANALYSIS METHODOLOGY:

Phase 1 - Repository Context Research (Use file search tools):
- Identify existing security frameworks and libraries in use
- Look for established secure coding patterns in the codebase
- Examine existing sanitization and validation patterns
- Understand the project's security model and threat model (already loaded above)

Phase 2 - Comparative Analysis:
- Compare new code changes against existing security patterns
- Identify deviations from established secure practices
- Look for inconsistent security implementations
- Flag code that introduces new attack surfaces

Phase 3 - Vulnerability Assessment:
- Examine each modified file for security implications
- Trace data flow from user inputs to sensitive operations
- Look for privilege boundaries being crossed unsafely
- Identify injection points and unsafe deserialization

REQUIRED OUTPUT FORMAT:

For each finding, output:

## <ID>: <short title>  (ID = next sequential integer after last entry in findings.md)
- **Severity**: HIGH / MEDIUM / LOW
- **File:Line**: path/to/file.ts:NN
- **Category**: e.g. ssrf, path-traversal, nosql-injection, privilege-escalation
- **Description**: one paragraph explaining the vulnerability
- **Exploit scenario**: concrete, specific attack path
- **Recommended fix**: specific code change
- **Confidence**: N/10

If no new findings: output `No new findings.`

SEVERITY GUIDELINES:
- **HIGH**: Directly exploitable vulnerabilities leading to RCE, data breach, or authentication bypass
- **MEDIUM**: Vulnerabilities requiring specific conditions but with significant impact
- **LOW**: Defense-in-depth issues or lower-impact vulnerabilities

CONFIDENCE SCORING:
- 0.9-1.0: Certain exploit path identified, tested if possible
- 0.8-0.9: Clear vulnerability pattern with known exploitation methods
- 0.7-0.8: Suspicious pattern requiring specific conditions to exploit
- Below 0.7: Don't report (too speculative)

FINAL REMINDER:
Focus on HIGH and MEDIUM findings only. Better to miss some theoretical issues than flood the report with false positives. Each finding should be something a security engineer would confidently raise in a PR review.

FALSE POSITIVE FILTERING:

> You do not need to run commands to reproduce the vulnerability, just read the code to determine if it is a real vulnerability. Do not use the bash tool or write to any files.
>
> HARD EXCLUSIONS - Automatically exclude findings matching these patterns:
> 1. Denial of Service (DOS) vulnerabilities or resource exhaustion attacks.
> 2. Secrets or credentials stored on disk if they are otherwise secured.
> 3. Rate limiting concerns or service overload scenarios.
> 4. Memory consumption or CPU exhaustion issues.
> 5. Lack of input validation on non-security-critical fields without proven security impact.
> 6. Input sanitization concerns for GitHub Action workflows unless they are clearly triggerable via untrusted input.
> 7. A lack of hardening measures. Code is not expected to implement all security best practices, only flag concrete vulnerabilities.
> 8. Race conditions or timing attacks that are theoretical rather than practical issues. Only report a race condition if it is concretely problematic.
> 9. Vulnerabilities related to outdated third-party libraries. These are managed separately and should not be reported here.
> 10. Memory safety issues are impossible in TypeScript/JavaScript. Do not report memory safety issues.
> 11. Files that are only unit tests or only used as part of running tests.
> 12. Log spoofing concerns. Outputting un-sanitized user input to logs is not a vulnerability.
> 13. SSRF vulnerabilities that only control the path. SSRF is only a concern if it can control the host or protocol.
> 14. Including user-controlled content in AI system prompts is not a vulnerability.
> 15. Regex injection. Injecting untrusted content into a regex is not a vulnerability (except where noted in MAGI-specific categories above).
> 16. Regex DOS concerns.
> 17. Insecure documentation. Do not report any findings in documentation files such as markdown files.
> 18. A lack of audit logs is not a vulnerability.
>
> MAGI PRECEDENTS - Do NOT report these patterns as vulnerabilities:
> 1. Data API keys (`FRED_API_KEY`, `FMP_API_KEY`, `NEWSAPIORG_API_KEY`) forwarded to `magi-job` children via `env_keep` are intentional and by design. These keys are scoped to data adapters and never reach agent tool-executor subprocesses.
> 2. `MAGI_TOOL_TOKEN` present in the `magi-job` environment is intentional — it is a short-lived bearer token that is revoked when the job exits.
> 3. MonitorServer (port 4000) being unauthenticated is a known accepted risk for the dev environment (see F-008 in findings tracker). Do not re-report it unless the change introduces a new mutating route.
> 4. Pool user sudoers rules (magi-w1 through magi-w6) with NOPASSWD for `/usr/local/bin/magi-job` and `/usr/local/bin/magi-node` are documented in ADR-0011. Do not report these as overly-permissive sudo rules.
> 5. `sharedDir` being writable by all agents is an accepted design trade-off for collaboration (see A-001 in findings tracker).
> 6. Environment variables and CLI flags passed by the operator are trusted values. Do not flag them as injection sources.
> 7. UUIDs used as bearer tokens can be assumed to be unguessable. Do not report entropy concerns about UUID-based tokens.
>
> SIGNAL QUALITY CRITERIA - For remaining findings, assess:
> 1. Is there a concrete, exploitable vulnerability with a clear attack path?
> 2. Does this represent a real security risk vs theoretical best practice?
> 3. Are there specific code locations and reproduction steps?
> 4. Would this finding be actionable for a security team?
>
> For each finding, assign a confidence score from 1-10:
> - 1-3: Low confidence, likely false positive or noise
> - 4-6: Medium confidence, needs investigation
> - 7-10: High confidence, likely true vulnerability

START ANALYSIS:

Begin your analysis now. Do this in 3 steps:

1. Use a sub-task to identify vulnerabilities. Use the repository exploration tools to understand the codebase context, then analyze the PR changes for security implications. In the prompt for this sub-task, include all of the above.
2. Then for each vulnerability identified by the above sub-task, create a new sub-task to filter out false-positives. Launch these sub-tasks as parallel sub-tasks. In the prompt for these sub-tasks, include everything in the "FALSE POSITIVE FILTERING" instructions.
3. Filter out any vulnerabilities where the sub-task reported a confidence less than 8.

Your final reply must contain the markdown report and nothing else. Append a final line:

**Threat model update needed?** YES / NO — reason in one sentence. (If YES, the operator should
run `/update-threat-model` before the next `/security-audit`. Triggers: new external HTTP call,
new subprocess/sudo rule, new server port, new env var forwarding, new MongoDB collection.)
