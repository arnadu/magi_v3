# Security assurance: scanners, a generated attack matrix, and agents that triage

**Status:** proposed 2026-11-23, for the product owner's approval.
**Replaces:** the "Security testing and detection" item in the roadmap's near-term list (its four
parts are kept, made concrete here), and the appsec and code-review parts of MAGI DEV's phase 0
as they run today (`magi-dev-requirements.md`).

## Why

MAGI DEV's reviewers produced, on 2026-11-22 and 23, mostly unusable security output:

- appsec's evidence for "all controls hold" was largely invented (a sudoers rule, an install
  path, four test names that do not exist); its drift sweep cited boundaries TB-30..33, which do
  not exist; its first red-team pass broke three of its own skill's rules and declared "held";
- the code reviewer described two commits that do not exist and invented the content of two
  real ones, after `git log` and `git diff` had shown it the right ones;
- every mechanical check we gave them (`check-citations.py`, `checklist.py`, the work list) was
  written into a skill and skipped.

The one reliable reviewer, the documenter, makes narrow claims that can each be checked. That is
the pattern, and it matches how working systems do this.

## What working systems have in common

Research summary, 2026-11-23 (sources at the end):

1. **Evidence is checked by code, separately from the model that proposed it.** XBOW: asking an
   LLM whether a finding is real gives very high false-positive rates; the agent must produce
   evidence that non-AI code validates. Big Sleep (a crash in a sandbox), Aardvark / Codex
   Security (reproduction in a sandbox), Buttercup (no patch without a proof of vulnerability).
2. **One narrow question per run, in a small context.** Heelan's o3 experiment: 8 of 100 runs
   found the bug with ~27K tokens of focused code, 1 of 100 with ~100K. Vulnhuntr and Bugbot fetch
   context on demand instead of loading it.
3. **Several independent samples; keep what they agree on** (Bugbot: 8 passes, majority vote,
   then a validator model).
4. **A separate pass tries to disprove each finding** (Claude Code Security, AgenticSCR).
5. **Deterministic tools find; the LLM triages** (IRIS with CodeQL, Buttercup with fuzzers).
   LLM agents are measurably good at filtering static-analysis alerts.
6. **Output is findings, never certificates.** No system reports "all controls hold".
7. **Measured by outcome:** Bugbot's resolution rate; Anthropic's human triage of every
   high-severity finding.

MAGI DEV did the opposite on each point: self-certified evidence, ~115K-token contexts, one pass,
self-validation, the model reading code end to end, certificates as the main deliverable, and
KPIs the agents score themselves.

## Principles of this plan

- **The platform holds when the model is fooled.** The threat model already treats a
  prompt-injected agent as an attacker holding that agent's OS user and tools. So most attacks
  need no LLM: a test acts as the compromised agent and calls its tools, the Tool API, its
  request folders and its shell directly. Deterministic, cheap, repeatable.
- **Every verdict is computed by code.** A test's oracle, a scanner's rule, an acceptance check.
  A model proposes; code decides.
- **A test must be able to fail.** It is run with its guard removed, and must fail there.
- **Findings, not assurance.** Coverage is counted by the harness, never stated by an agent.
- **Agents never probe live systems** (as decided for the security-testing item): no
  agent-enforced scope, a shared private network and database, Fly's acceptable-use policy.

## What exists already

| Layer | In place | Gap |
|---|---|---|
| Static analysis | Semgrep `p/default`, CodeQL `javascript-security-extended` (in the trace, results filed under the `sec.*` invariants), `npm audit` (production, high+), gitleaks, shellcheck (errors), actionlint, the repo's tripwires | No image scan (OS packages, Python venv); no rules of our own for our invariants beyond grep tripwires; nobody triages CodeQL's results |
| Attack surface as data | The trace's `entry-points.json` (220 entries: kind, actor, tag, code reached), `trust-boundaries.md` (attackers and what they hold), 13 `sec.*` invariants | Not used to generate tests |
| Tests of guards | Unit tests across the repo; tests named by invariant for 9 of 13 (`sec.tenant-scoped`, `sec.no-secrets-to-agents`, `sec.secrets-not-recorded`, `sec.confirmed-effects` have none) | No systematic matrix; nothing checks that a test can fail |
| Environments | Local integration tests against real pool users (45 files, run by hand) | CI runs no integration test, and nothing runs inside the shipped mission image |
| Dynamic / fuzz | Live hostile checks done by hand (ADR-0037) | No fuzzing, no outside-in scan |

## The design

### 1. Static scanners in CI (extend)

- **Image scan:** trivy on the mission image and the control plane image (OS packages, the
  Python venv, Node modules as shipped); high+ fails, with the same exception list mechanism as
  `npm audit`.
- **Our own Semgrep rules** for invariants that grep cannot express well: a `sudo` spawn names a
  fixed helper path; a path from input goes through `resolveInside`; a Mongo filter from input is
  scoped to `missionId`; a route is wrapped in the auth middleware. Each rule has planted samples
  that it must match (as the tripwires' selftest does).
- **hadolint** on the Dockerfiles; shellcheck ratcheted to warnings.
- **One alerts file** per CI run (`analysis/alerts.json`: CodeQL, Semgrep, trivy, with stable
  ids), kept private as `security.json` is today. It is the agents' triage queue (part 5).

### 2. The attack matrix, generated from the catalog

A generator (`scripts/security/matrix.mjs`) reads `entry-points.json`, `trust-boundaries.md`'s
attackers and the invariants, and writes the matrix: **entry point × attacker who can reach it ×
attack class for that kind of entry point**. Each class has a test template and a code oracle:

| Entry kind | Attack classes | Oracle |
|---|---|---|
| Control-plane route (64) | no auth; another tenant's mission (IDOR); unconfirmed mutation; operator and field names in parameters | 401/404, and the other tenant's documents unchanged |
| Monitor route (35) | no token, another mission's token; traversal; symlinks | refused; a canary outside the root never returned |
| Agent tool (78) | path escape; symlink and hard-link plants; argument injection; a teammate's workdir | canaries owned by another agent unread and unchanged |
| Tool API (8) | expired, revoked, another agent's token; scope | refused; no side effect |
| Request folders (5) | ownership spoofing; symlinks; malformed and oversized files; naming another agent | rejected; nothing runs as another user |
| Privileged helpers (sudo, `magi-net`, `magi-app`) | argument and environment injection; forbidden uids and ports | a canary environment variable never reaches the child; refusal codes |
| Timers and change streams (17) | overlap, crash mid-run, replay | the invariant holds afterwards |

Each cell is one of: **covered** (a test exists and passed the can-fail check), **open**, or
**n/a** with a reason a person approved. The harness counts them; the count is the coverage
figure, by invariant and by component.

**The can-fail check.** A test is accepted only if it fails with its guard removed. Two ways:
- *historical:* our security fixes (F-032..F-082) are known answers; a test for that cell must
  fail at the fix's parent commit and pass at the fix (run in a worktree);
- *mutation:* for a guard with no history, the test runs against the code with the guard's call
  stubbed out (a small list of named guards: `resolveInside`, `userFilter`, `safeEqual`, the
  owner attribution, `checkToolArguments`, …).

### 3. Three environments

1. **In-process, every push.** Routes with two fake tenants (supertest), tools and validators
   against temporary directories. Most route and tool cells live here.
2. **The shipped mission image, in CI.** A job starts the image in Docker (`NET_ADMIN`, a test
   team, dummy secrets, a test database), then attacks inside it as the agent users
   (`docker exec -u`): sudoers, ACLs, request folders, `magi-net`, `magi-app`, environment
   canaries, exactly as shipped. On changes to the runtime or the Dockerfile, and nightly.
3. **Fly, run by the operator.** What only Fly has: the private network between machines, Fly
   SSH, the kernel's nftables features. A scripted runbook on a throwaway app in our organization
   (as for the apps spike), after Fly acknowledges the testing.

### 4. Fuzzing and an outside-in scan

- **Property-based fuzzing** (`fast-check`) of the parsers and validators: team-file paths,
  `resolveInside`, job and schedule specs, `checkToolArguments`, request-file validation, and the
  markdown renderer (no script reaches the DOM, checked with jsdom).
- **OWASP ZAP baseline** against a locally started control plane and apps host in CI: headers,
  cookies, CSP, and the known routes.

### 5. What the MAGI DEV agents do

Their role narrows to the two things models are measurably good at, under mechanical acceptance:

- **Triage the alerts** (part 1) and the change's new matrix cells (part 2). Each item is one
  question, worked in a **fresh, small context**: a sub-loop given the item and tools to fetch
  code, never the agent's own history. Each item is run **N times independently** (N = 3 to
  start); a candidate finding needs agreement from at least two runs, then survives a **refuter
  run** that tries to disprove it (another prompt, ideally another model). Output is structured
  (JSON), not prose.
- **Extend the matrix:** propose attack classes and cells, and write the test for an open cell.
  The test is accepted by the harness (it runs, and passes the can-fail check), not by the agent.
- **Mechanical acceptance of everything they report**, run outside the agent: every cited file,
  line, test name and commit exists; quoted code matches the file at that line; the subject
  beside a commit hash is that commit's subject. Above low severity, a finding needs a test or
  script that runs. A report that fails is not counted, and the misses go back to its author.
- **No certificates.** "APPROVE", "all controls hold", "held against N attacks" and "no drift"
  are dropped from the skills. A change review lists findings, and the harness lists what was
  examined (from the agent's actual tool calls).
- The long-lived agent becomes a coordinator: it picks the items, runs the workers, files what
  survives, and keeps the register.

The documenter keeps its current shape: its claims are already narrow and checkable. The QA
lead's journey reviews move towards proposing test cells. The code reviewer's change reviews move
to the same worker pattern.

### 6. Measurement

- **A known-answer benchmark**, run offline on every change to the pipeline or the agents'
  skills: #96's items, F-082, and the historical security fixes. Scored by code: which known
  answers each configuration finds, at what cost.
- **Model choice from the benchmark:** GLM 5.2 against a stronger model for the worker and the
  refuter, not chosen on price.
- **In production:** the share of the agents' findings that I verify and you accept (the
  equivalent of Bugbot's resolution rate). The agents' self-scored KPIs are retired.

## Steps

Each step is a commit series with its tests and docs, like the interactive-apps slices.

| Step | What | Size |
|---|---|---|
| 1 | **Acceptance gate and no certificates.** The checker learns commits, subjects and quoted code; it runs as a scheduled job over every new report, outside the agents; the skills drop certificate verdicts; the agents' wrong beliefs from 2026-11-23 are corrected. The documenter can resume on this alone. | 1 day |
| 2 | **Static scanners:** trivy, hadolint, our Semgrep rules with planted samples, `alerts.json`. | 1–1.5 days |
| 3 | **Attack matrix generator and in-process templates** (routes with two tenants, tools), the can-fail check with historical known answers (F-082 first), coverage counts. The four invariants with no test get theirs here. | 3 days |
| 4 | **The mission image as a sandbox in CI:** the Docker job, the attack runner as agent users, templates for request folders, helpers and environment canaries. | 3–4 days |
| 5 | **Fuzzing and ZAP.** | 1.5–2 days |
| 6 | **MAGI DEV redesign:** fresh-context workers, N runs and a refuter, structured output, coordinator agents, new skills; the known-answer benchmark and the model comparison. | 3 days |
| 7 | **Fly runbook** for the operator's probes, and the detections list from the security-testing item, with G-5 alerting where needed. | 1–2 days |

About 14–17 days in all. Steps 1–2 pay off whatever else is decided; 3–4 give the coverage
figure; 6 depends on 1 and 3.

## Decisions for the product owner

1. **Approve the direction:** scanners and generated tests decide; agents triage and propose,
   under mechanical acceptance; no certificates.
2. **How agents' test code reaches the repository.** Proposed: as a patch in the mission's shared
   folder that has passed the can-fail check; I review and commit it (no pull requests, as today).
3. **CI time.** Proposed: in-process cells on every push; the image sandbox on runtime or
   Dockerfile changes and nightly; ZAP nightly.
4. **Model budget** for the benchmark (a few dollars per configuration per run).
5. **MAGI DEV until step 6:** proposed, the documenter resumes after step 1; appsec and the code
   reviewer stay off.

## Not in this plan

Design and business-logic review (it stays with design reviews and the product owner); the
model's own susceptibility to prompt injection (the design does not rely on it); wider Fly access
for the copilots or MAGI DEV (postponed, roadmap); the outbound firewall and the per-uid loopback
rule (their own items, which this matrix will cover once built).

## Sources

- XBOW, Black Hat USA 2025, "AI agents for offsec with zero false positives":
  https://i.blackhat.com/BH-USA-25/Presentations/US-25-Dolan-Gavitt-AI-Agents-for-Offsec-with-Zero-False-Positives-Thursday.pdf
- XBOW, "200 zero-days, zero false positives": https://xbow.com/blog/200-zero-days-zero-false-positives-how-xbow-scales-ai-exploitation
- Project Zero, "From Naptime to Big Sleep": https://projectzero.google/2024/10/from-naptime-to-big-sleep.html
- OpenAI, "Introducing Aardvark": https://openai.com/index/introducing-aardvark
- Trail of Bits, Buttercup (AIxCC): https://blog.trailofbits.com/2025/08/09/trail-of-bits-buttercup-wins-2nd-place-in-aixcc-challenge/
- Sean Heelan, "How I used o3 to find CVE-2025-37899": https://sean.heelan.io/2025/05/22/how-i-used-o3-to-find-cve-2025-37899-a-remote-zeroday-vulnerability-in-the-linux-kernels-smb-implementation/
- Protect AI, Vulnhuntr: https://github.com/protectai/vulnhuntr
- Cursor, "Building Bugbot": https://cursor.com/blog/building-bugbot
- Anthropic, Claude Code Security: https://anthropic.com/news/claude-code-security
- Anthropic, claude-code-security-review: https://github.com/anthropics/claude-code-security-review
- IRIS (ICLR 2025): https://arxiv.org/abs/2405.17238v3
- Sifting the Noise (arXiv 2601.22952): https://arxiv.org/html/2601.22952v2
- AgenticSCR (arXiv 2601.19138): https://arxiv.org/html/2601.19138v1
- curl ends its bug bounty: https://thenewstack.io/drowning-in-ai-slop-reports-curl-ends-bug-bounties/
