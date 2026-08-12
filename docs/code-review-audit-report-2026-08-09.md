# MAGI-V3 Code Review and Deployment Audit Report

Audit date: 2026-08-09
Assessment: source, configuration, documentation, CI/CD, and local validation audit.

## Executive Decision

Investment: invest conditionally. MAGI-V3 has a differentiated core: persistent multi-agent missions, per-mission execution environments, cost/accountability features, a control plane, and serious operational-recovery work. Its product core merits investment, but the critical cloud-isolation failures below must be resolved before further cloud product rollout.

Deployment: do not deploy the current cloud execution-plane image. Do not deploy for multi-tenant, external-facing, confidential, regulated, legal, financial-decision, or production-automation use cases. A disposable local proof of concept is conditionally acceptable only for public-data research with human review, no external credentials, no background-job data keys, and no external side effects.

The central blocker is not routine agent unreliability. A production agent can escalate to root, and a tenant-controlled agent identifier can execute shell commands on startup. Either flaw exposes the execution-plane environment, including shared MongoDB and LLM/provider credentials.

## Scope and Evidence

This was a source, configuration, documentation, CI/CD, and local-validation audit. No live cloud credentials, LLM provider, production MongoDB database, or external penetration-test target was used. It is an implementation audit, not a substitute for an independent penetration test and live recovery exercise after remediation.

Validation completed:

- npm run build passed. The cockpit build emitted a 1.1 MB initial JavaScript bundle warning and a warning for the non-module firebase configuration script.
- npm run lint passed over 192 files.
- The complete unit suite passed outside the sandbox: 340 tests in 38 files. The initial sandbox run failed only because it forbids localhost listeners and git subprocesses; the outside-sandbox rerun passed.
- npm run test:coverage cannot run because the Vitest coverage provider dependency is absent.
- Dependency advisory results are unknown. npm audit could not be completed because the safe execution environment could not resolve npm and an external retry would send private dependency metadata. Semgrep could not initialize its settings directory, and Gitleaks is not installed. These are evidence gaps, not clean results.

## Deployment Matrix

| Deployment/use case | Current decision | Conditions |
|---|---|---|
| Disposable local developer proof of concept using public web data | Conditional | Dedicated disposable Linux host; no production credentials; disable background jobs/data keys; human review; no confidential input. |
| Single-tenant cloud research | No | Close all critical/high findings, complete cloud integration/recovery tests, and establish supply-chain gates. |
| Multi-tenant cloud SaaS | No | Additionally isolate data, credentials, storage, and network access per tenant; obtain independent penetration testing. |
| External publishing, GitHub writes, or other external actions | No | Server-enforced confirmation for every external action; prompt-injection testing; durable audit trail. |
| Software delivery to production systems | No | Separate hardened build/deploy worker, scoped credentials, protected release pipeline, and mandatory human approval. |
| Equity research for internal information use | No in cloud; conditional local POC | Public data only, not-investment-advice posture, human approval before distribution, no trading/execution integration. |
| Thesis/writing support | No in cloud; conditional local POC | Non-sensitive material only; plagiarism/citation review by a human. |
| DPO, legal, procurement, or vendor-risk workflows | Prohibited | Sensitive personal/legal/commercial controls, encryption, retention, evaluation, and approval requirements are not implemented. |

## Product, Feature, and Architecture

MAGI-V3 is more than a chat wrapper. It provides agent teams, role/supervisor structure, persistent mailbox-driven orchestration, memory/reflection, cost limits and attribution, file and shell tools, web search/fetch/browser tooling, background jobs, a cockpit, mission/control copilots, scheduled wakeups, and a cloud control-plane/execution-plane split. The primary equity-research configuration is concrete; the repository also includes general-assistant, gold-digest, objectives, and copilot templates.

The strongest design choices are the control-plane/execution-plane split, structured configuration validation, MongoDB-backed state, cost telemetry, mission-recovery work, and explicit security records. The feature set is appropriate for long-running internal research missions once privilege isolation is fixed.

Key constraints:

- Agents intentionally have real shell, browser, filesystem, background-job, and optional external-write capability. That is viable only with minimal, independently verified privilege boundaries; those boundaries do not currently hold.
- Every mission machine receives high-value shared secrets, widening one mission compromise to the whole environment. See packages/control-plane/src/fly-machines.ts:161.
- The use-case portfolio defines useful KPIs, but there is no evaluation harness or recorded outcome-quality evidence for research, citations, agent collaboration, or operator workload.
- DPO, legal, procurement, and production website-delivery use cases are intrinsically high-risk and should not be treated as deployment candidates merely because the platform can generate relevant artifacts.

## Code Quality and Maintainability

Strengths:

- Strict TypeScript, Zod configuration parsing, Biome linting, and 340 passing unit tests establish a good baseline.
- State, cost, and recovery trade-offs are unusually well documented in ADRs and operational history.
- Package responsibilities are clear: agent-config, agent-runtime-worker, control-plane, and cockpit.

Debt and design issues:

- Critical behavior is concentrated in large files: monitor-server.ts (~61.6 KB), daemon.ts (~52.0 KB), mission-copilot-tools.ts (~44.2 KB), and missions.ts (~39.5 KB). Routing, authorization, persistence, orchestration, and policy are interleaved, making high-risk changes hard to review. Split by bounded domain before adding features.
- The audit found 62 any/noExplicitAny occurrences. Most are boundary/test justifications, but monitor data paths should move from raw Mongo documents to validated DTOs.
- The only production TODO found is the known cross-user ListSchedule scoping issue, F-024 in docs/security/findings.md:20. It cannot remain open for multi-tenancy.
- Coverage is not measurable because the configured coverage provider is missing, and no coverage threshold runs in CI.
- The cockpit initial bundle is large. Code splitting is worthwhile after security blockers are fixed.

## Security Findings

| ID | Severity | Finding and evidence | Required remediation |
|---|---|---|---|
| CR-01 | Critical | Any production agent can become root. The execution image gives every pool user passwordless sudo access to magi-node and magi-job with ALL run-as rights. Those wrappers execute arbitrary Node arguments and arbitrary commands; dynamic user creation writes the same rules. See packages/agent-runtime-worker/Dockerfile:66, :78, and :89. An agent has Bash access, so a malicious task or prompt injection can invoke them directly. | Remove all sudo permissions from agent users. Only the daemon identity may use a narrowly scoped, argument-validating helper to start the fixed tool executor as a specified agent. Do not grant a user a wrapper that forwards arbitrary arguments or commands. Add an image integration test proving an agent cannot execute as root or another agent. Rebuild and redeploy all images; rotate all secrets. |
| CR-02 | Critical | A tenant-controlled agent ID reaches shell interpolation during startup. Agent IDs require only a non-empty string, but ensureAgentUsers passes the ID, when linuxUser is omitted, into shell command strings. The cloud daemon identity can then run arbitrary Node/job wrappers as root. See packages/agent-config/src/loader.ts:29, packages/agent-runtime-worker/src/daemon.ts:567, and packages/agent-runtime-worker/Dockerfile:80. | Restrict every identifier used in shell, path, URL, header, database, or OS-user contexts to one shared slug schema. Replace string execSync commands with execFileSync argument arrays. Apply CR-01 least privilege so a future injection cannot reach root. Add hostile-ID tests at mission creation and daemon startup. |
| CR-03 | High | BrowseWeb SSRF protection is falsely reported as fixed. The threat model says a request interceptor protects agent-driven navigation, but current Stagehand V3 has no interceptor and says it cannot use one. The code checks initial navigation and post-redirect URLs only, while agent().execute() can navigate further. See packages/agent-runtime-worker/src/tools/browse-web.ts:201, :307, and docs/security/threat-model.md:381. | Reopen F-002. Enforce egress at a network boundary or use browser tooling that intercepts every request and popup/new-tab navigation. Until then, remove agentic browser execution or restrict it to an allowlist. Add redirect, click, JavaScript-navigation, XHR/fetch, and popup tests. |
| CR-04 | High | One mission compromise has cross-tenant secret/data scope. The control plane injects a shared MongoDB URI, Anthropic/OpenRouter credentials, search key, and data API keys into every mission machine. Root compromise under CR-01 exposes them. See packages/control-plane/src/fly-machines.ts:161. Even without CR-01, agent-authored background jobs receive data keys; see packages/agent-runtime-worker/src/daemon.ts:80 and :365. This contradicts the README statement that agents do not access API secrets. | Use per-mission/per-tenant least-privilege credentials with short rotation. Do not expose broad database credentials to execution machines. Put provider calls behind a scoped service/gateway. Treat job code as agent-controlled and do not pass reusable secrets to it. |
| CR-05 | Medium | Authentication tokens are accepted in query strings and stored in a JavaScript-readable, non-Secure cookie; standard browser hardening headers are absent. Query tokens may leak through logs, history, and referrers; XSS impact is higher for a JS-readable session. See packages/control-plane/src/auth.ts:26, packages/cockpit/src/auth.ts:42, and packages/control-plane/src/index.ts:88. | Allow query tokens only for SSE with short-lived stream tokens and redaction. Prefer Authorization headers or server-set HttpOnly, Secure cookies. Add CSP, HSTS, content-type, and clickjacking headers with tests. |
| CR-06 | Medium | CI/CD supply-chain gates are incomplete. Deployment workflows use mutable action references such as setup-flyctl@master, deploy independently of quality checks, and publish/consume latest. CI has Semgrep but no secrets, dependency, Python, image, SBOM, provenance, or license gate. Python dependencies are open ranges. See .github/workflows/build-execution-image.yml:1, .github/workflows/deploy-control-plane.yml:40, .github/workflows/quality.yml:32, and packages/skills/data-factory/requirements.txt:1. | Pin actions/base images by immutable SHA/digest; require verified test, SAST, secrets, dependency, image, and license gates before deploy; generate SBOM/provenance; pin/scan Python dependencies; prohibit latest in production. |
| CR-07 | Medium | Confirmation controls remain incomplete for AI-initiated external and disruptive actions. Existing F-021, F-023, F-025, and F-026 document immediate GitHub writes, budget increases, pauses, schedule/job cancellation, and related mission changes, often with untrusted web-derived context. | Treat external writes and material mission-state changes as server-enforced proposal/approval actions. Close existing findings before any external-action deployment. |
| CR-08 | Medium | Sensitive-data deployment is unready. The project confirms zero application-level encryption today; providers receive plaintext, and the encryption/ZDR direction is deferred. See docs/adr/0026-sensitive-data-encryption-direction.md:12. | Prohibit sensitive/regulated data until privacy architecture, encryption/key custody, retention, data-subject rights, provider controls, and independent review are implemented and tested. |

Existing findings: the repository already declares seven open findings as mandatory before production in docs/security/findings.md:11. Close F-021 through F-026 and F-029, or formally accept each with a restricted deployment policy. F-024 is a cross-user schedule disclosure issue and cannot remain open for multi-tenant operation.

## Operations, Governance, and Documentation

The recovery design is promising: persistent state, restart policy, bounded job recovery, anomaly records, and fresh cost-limit reads address several real incidents. No live cloud recovery, backup restore, tenant-isolation, LLM outage, or cost-exhaustion exercise was available to this audit.

Remaining readiness gaps:

- The operational guide documents no Fly Volume disk monitoring and no out-of-band alerting for LLM failures (docs/operational-resilience.md:229).
- The worker is sized at 1 GB while its own documentation acknowledges Chromium can exceed that peak with no OOM alert (docs/operational-resilience.md:45).
- No stated SLOs, RTO/RPO targets, backup/restore evidence, capacity plan, or incident exercises support production commitments.
- Prompt-injection markers are defense-in-depth, not enough to make autonomous high-impact action safe. The browser egress gap and unconfirmed copilot actions are material.
- There is no measured model-quality/evaluation program supporting legal, financial, compliance, or procurement recommendations.

Documentation is rich but materially inaccurate in places:

- The security tracker/threat model mark BrowseWeb interception fixed, but source says Stagehand V3 cannot provide it.
- The security guide claims pip-audit and Semgrep/Gitleaks pre-commit behavior that the script/hook do not implement. Compare docs/security/CLAUDE.md:12, package.json:17, and .githooks/pre-commit:1.
- The README says agents do not access API secrets, while background jobs receive data keys and CR-01 permits broader exposure. Compare README.md:17 and packages/agent-runtime-worker/src/daemon.ts:80.
- The operational runbook says the missed-cron gap is both closed and unmitigated. Compare docs/operational-resilience.md:234 and :267.
- README requires Node 20+, while package metadata permits Node 18+. Align documentation, package metadata, CI, and Docker.

## Remediation Roadmap and Decision Gates

### Immediate: stop cloud deployment

1. Fix CR-01 and CR-02; test the final image with malicious shell commands and hostile configuration identifiers. Rotate MongoDB, LLM, Fly, monitor-signing, GitHub, and data-provider secrets.
2. Reopen and fix F-002/CR-03 through enforceable browser/network egress policy.
3. Remove broad mission-machine credentials; scope credentials per tenant/mission and separate provider/database access from agent execution.
4. Disable external GitHub writes and unconfirmed mission-copilot state changes until server-side approval exists.
5. Correct the threat model, findings tracker, README, security guide, and operational runbook.

### Next 30 days: production assurance baseline

1. Add CI gates for tests, coverage, Semgrep, Gitleaks, npm/Python auditing, image scanning, dependency/license review, SBOM, and provenance. Pin actions and base images.
2. Restore the coverage provider and establish risk-weighted coverage targets for authorization, sudo/tool isolation, browser egress, provision/resume/destroy, and recovery.
3. Add security headers and tighten token/session handling.
4. Resolve all open findings and add regression tests.
5. Run isolated cloud integration tests for provisioning, proxy authorization, machine replacement, secret isolation, backup/restore, and failure recovery.

### 31-90 days: earn a limited deployment decision

1. Obtain an independent application/cloud penetration test after remediation.
2. Define SLOs, RTO/RPO, backup retention, data retention/deletion, alerting, on-call ownership, and incident exercises.
3. Build a product-evaluation program with representative tasks, citation/accuracy criteria, prompt-injection scenarios, cost/reliability metrics, and human-review quality measures.
4. Complete privacy/legal review and only then design sensitive-data support around encryption and provider-retention controls.
5. Refactor oversized orchestration/routing modules around stable internal interfaces.

Reconsider a single-tenant cloud pilot only when CR-01 through CR-08 and all open security findings have verified fixes, CI security evidence is available, cloud recovery tests pass, and an external penetration test finds no unresolved critical/high issue. Reconsider multi-tenancy only after per-tenant credential/data isolation and a dedicated tenant-isolation assessment.
