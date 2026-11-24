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

### 1. The tool suite, by what it protects against (decided 2026-11-23)

"Kind": *off-the-shelf* (a public tool with its standard rules), *adapted* (our configuration or
exception list), *built* (ours). Every tool's output is a finding to triage, never an all-clear.

| Threat | Tool | Status | Kind | Purpose | Alternatives and why not |
|---|---|---|---|---|---|
| Known-vulnerable dependencies | `npm audit` (better-npm-audit, production, high+) | in CI | adapted (exception list) | CVEs in the npm packages we ship | OSV-Scanner: wider database, not worth a migration while this works |
| | **trivy image** (mission and control-plane images) | step 2 | adapted (threshold, exceptions) | What npm audit cannot see: Debian packages, Chromium/Playwright, the Python venv, Node modules as shipped | Grype: similar, but trivy also does secrets and misconfiguration in one tool; Snyk, Docker Scout: SaaS accounts, code leaves; pip-audit: Python only |
| | Dependabot alerts | on (2026-11-23) | off-the-shelf | Advisories between pushes; alerts only, no pull requests | Renovate: centred on pull requests |
| | **trivy on the images that run** (nightly: each machine's image digest from the Machines API) | step 7 | adapted | What CI's scan of the latest build cannot see: an older image still running on a long-lived machine | `flyctl registry vulns / vulnsummary / sbom` (Fly's own scanner, experimental): every call timed out on 2026-11-23, missions and control plane alike; worth retrying as a second opinion, not a base |
| Secrets exposure | gitleaks (full history) | in CI | off-the-shelf | Keys committed to the repository | TruffleHog: can verify a key is live by calling its provider; not needed (a found key is rotated anyway) and it sends the key out |
| | **trivy secret** (image layers) | step 2 | off-the-shelf | A key or `.env` baked into an image layer | — |
| | GitHub secret scanning and push protection | on (found 2026-11-23) | off-the-shelf | Known key formats refused at push | — |
| Code vulnerabilities | Semgrep `p/default` | in CI | off-the-shelf | Generic injection, unsafe APIs, crypto misuse (TypeScript, Python, shell) | — |
| | CodeQL `javascript-security-extended` (in the trace) | in CI | adapted (results filed under `sec.*`) | Taint flows from input to dangerous sinks; today nobody triages it, part 5 makes it the agents' queue | SonarQube/SonarCloud, Snyk Code: heavier, SaaS, overlapping |
| | Tripwires (16 grep checks, planted samples, allow list) | in CI | built | Our own rules: HTML sinks, child-process environments, git outside `safe-git`, raw mailbox inserts… | Kept; the most valuable move to Semgrep |
| | **Our Semgrep rules** (with planted samples) | step 2 | built | Invariants grep cannot express: `sudo` only through a fixed helper; paths from input through `resolveInside`; Mongo filters from input scoped to `missionId`; every route behind the auth middleware | CodeQL custom queries: stronger taint tracking, slower to write; later. ESLint security plugins: a second linter beside Biome |
| Pipeline and build configuration | shellcheck | in CI (errors) | off-the-shelf | Unsafe shell, root helpers included; ratchet to warnings script by script | — |
| | actionlint | in CI | off-the-shelf | Correctness of the workflows | — |
| | **zizmor** | step 2 | off-the-shelf | Security of the workflows: script injection, token permissions, unpinned actions | OpenSSF Scorecard: broader, less specific; maybe later |
| | **trivy config** (Dockerfiles) | step 2 | off-the-shelf | Root user, secrets in build arguments, unpinned bases | hadolint: mostly style; trivy covers the security part with one tool fewer |
| | Deployed-configuration checks (read-only, Fly API) | step 7 | built | What runs matches what we intend: no public IPs or services on the missions apps, secrets per app, image user and digest; **every app in the organisation that holds a platform secret (same digest) is a known component** (F-083: a forgotten May deployment held dev's database and admin key for six months and ran a second scheduler) | Nothing off-the-shelf knows Fly |
| Our isolation and authorization guards | **Attack matrix** and its tests | steps 3–4 | built | Part 2 | No scanner knows "another tenant's mission" or "a teammate's workdir" |
| | **Can-fail check** | step 3 | built | Each test fails with its guard removed | Stryker (full mutation testing): slow and noisy; mutating only our guards is enough |
| Input handling | **fast-check** properties | step 5 | off-the-shelf library, built properties | Adversarial inputs to our validators and the markdown renderer | Jazzer.js (coverage-guided): heavier; revisit if fast-check finds things |
| Running application | **Nuclei** | step 5 | adapted: pinned, signed community templates; built: our own templates | (1) exposure and CVE templates on the control plane and the apps host, including JupyterLab and Gradio; (2) fuzzing every route from the OpenAPI files (environment B only); (3) our templates for the matrix's HTTP cells, the oracle written in the template; (4) the Fly private-network probes as network templates (environment D); (5) headless checks of the cockpit (a script in agent output never runs, the CSP holds) | ZAP: overlaps; its remaining strength, crawling a single-page app, is replaced by the OpenAPI files; dropped for now. Burp: commercial, manual. Nikto: dated |
| The model's own behaviour | (none) | — | — | The platform is tested with the agent assumed compromised (part 2) | garak, promptfoo: measure the model, not our guards, and vary run to run; maybe later for the copilots' confirmation flows |
| The reviewers' output | Report gate, known-answer benchmark | step 1 done, step 6 | built | Part 5 | — |

**Nuclei guardrails:** templates pinned to a version; unsigned templates refused (`-dut`); code
templates (which run shell on the scanner) off; no `-ai` template generation (it sends data out) and
no `-llm` matching (a model's judgement as the oracle again). Fuzzing (`-dast`) runs only in
environment B. Community templates against dev run at a low rate, and only after Fly has
acknowledged the testing.

**One alerts file** per CI run (`analysis/alerts.json`: CodeQL, Semgrep, trivy, zizmor, with stable
ids), kept private as `security.json` is today. It is the agents' triage queue (part 5).

### 1b. The OpenAPI files (decided 2026-11-23)

Three files, one per surface: the public control-plane API, the monitor server (port 4000, behind
its token) and the Tool API (port 4001, loopback). They are generated, never hand-written: paths,
methods, path parameters, the catalog operation, the caller and the authentication from the trace's
route list, and request bodies from the Zod schemas the routes already validate with
(`zod-to-openapi`), added route by route. Extensions `x-magi-operation`, `x-magi-actor`,
`x-magi-auth` and `x-magi-tenant-scoped` make the security contract checkable: a test fails on a
route missing from a file or a file entry with no route, and on a route without authentication or
tenant scoping that the catalog does not declare public. The baseline catalog stays the product's
truth; the files are its HTTP view. Uses: the scanners' complete target list, the matrix's HTTP
cells, and a map of the surface for reviewers. Not chosen: a hand-written spec (about 110 routes,
it would drift), a decorator framework (a rewrite), runtime validation against the spec (a second
source of truth beside Zod).

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

### 3. Test environments

| Environment | What runs | Tests there | Cannot test |
|---|---|---|---|
| **A. In-process (vitest), every push** | Routes, tools and validators against temporary folders and a fake database | Most route and tool cells; fast-check properties | OS users, sudo, the firewall |
| **B. Local stack in CI, nightly** | The control plane and the apps host as processes; a MongoDB service container of Atlas's major version (not Atlas); dummy secrets; missions in local-execution mode; no real model (a scripted one where a turn is needed); two tenants through a **test-only sign-in** that cannot be enabled on Fly | Nuclei (templates, OpenAPI fuzzing, our HTTP cells, headless); cross-tenant cells end to end | Fly specifics |
| **C. The shipped mission image as a sandbox, on runtime or Dockerfile changes and nightly** | The image CI just built (the digest Fly runs), started with `NET_ADMIN`, a test team, the MongoDB container, dummy keys; attacks run inside as the agent users (`docker exec -u`) | sudoers, ACLs, request folders, `magi-net`, `magi-app`, environment canaries, Tool API tokens | The private network between machines, Fly SSH, Fly's kernel |
| **D. Fly staging, run by the operator** | A throwaway app in our organization, two machines, our images, after Fly has acknowledged the testing | The private network, Fly SSH, nftables on Fly's kernel, the proxy chain, the apps host's ports (Nuclei network templates) | Nothing automated; agents never run here |

No environment holds production data, Atlas, real model keys or real users. The test-only sign-in
is a new authentication path: it gets its threat-model entry and a tripwire (refused whenever
`FLY_APP_NAME` is set, like an empty `MONITOR_TOKEN`) in the commit that adds it.

### 4. Fuzzing

**Property-based fuzzing** (`fast-check`) of the parsers and validators: team-file paths,
`resolveInside`, job and schedule specs, `checkToolArguments`, request-file validation, and the
markdown renderer (no script reaches the DOM, checked with jsdom).

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
| 2 | **Static scanners:** trivy (image, secrets, configuration), zizmor, our Semgrep rules with planted samples, `alerts.json`; Dependabot alerts on. | 1–1.5 days |
| 2b | **The OpenAPI files**, generated from the trace and the Zod schemas, with the drift and contract test. | 1.5–2 days |
| 3 | **Attack matrix generator and in-process templates** (routes with two tenants, tools), the can-fail check with historical known answers (F-082 first), coverage counts. The four invariants with no test get theirs here. | 3 days |
| 4 | **The mission image as a sandbox in CI:** the Docker job, the attack runner as agent users, templates for request folders, helpers and environment canaries. | 3–4 days |
| 5 | **fast-check, and Nuclei** in environment B (with the test-only sign-in and the MongoDB container), and lightly against dev. | 2–3 days |
| 6 | **MAGI DEV redesign** (the alerts reach the mission privately: the repository is public, so neither the `trace` branch nor a CI artifact may carry them): fresh-context workers, N runs and a refuter, structured output, coordinator agents, new skills; the known-answer benchmark and the model comparison. | 3 days |
| 7 | **Fly runbook** for the operator's probes (Nuclei network templates) and the deployed-configuration checks, and the detections list from the security-testing item, with G-5 alerting where needed. | 1–2 days |

About 17–21 days in all. Steps 1–2 pay off whatever else is decided; 3–4 give the coverage
figure; 6 depends on 1 and 3.

### Progress
- **Step 2b, 2026-11-24:** `docs/api/` holds four OpenAPI files generated from the code as built:
  the control plane (61 routes, read from `createApp` through `mount()` and the operation markers),
  the apps host (4), the monitor server (its route table; regex routes read as path templates) and
  the Tool API (its tool names). A test regenerates and compares them (`npm run docs:api`), and
  enforces the contract on every route: it names an operation the catalog defines, and is public
  only when listed with a reason; the reader and the contract are proven on a planted app. The
  app's assembly moved from `index.ts` to `createApp(deps)`, which the attack tests (step 3) will
  build the same way. Not yet: request bodies from the Zod schemas (declared as objects for now),
  and the tenant-scoping claim per route, which the matrix's cross-tenant cells will test rather
  than declare.
- **Image hardening, 2026-11-23:** the mission image scan went from 45 high/critical findings (3
  critical) to 10 high and then none expected: production dependencies only in both images
  (`npm prune --omit=dev`: esbuild, vite, vitest, tinypool out), a fresh `node:22-slim` and
  `apt-get upgrade` at build, setuptools raised in the venv, npm 11.21.2 in place of the base's
  10.9.10 (its bundled packages carried the last ten). soupsieve's fix needs Python >= 3.11.5 and
  bookworm ships 3.11.2: an expiring exception (`.trivyignore.yaml`) until the base moves to a
  newer Debian. The scan is now a gate on fixable critical vulnerabilities and on any secret in a
  layer; high findings are reported to code scanning. Found on the way: the daemon imported
  `dotenv` without declaring it.
- **Step 2, 2026-11-23:** zizmor and trivy's Dockerfile scan gate CI (both clean after fixing
  zizmor's 12 medium findings: checkout no longer persists the workflow token, and the deploy and
  image workflows receive only `FLY_API_TOKEN_CI` instead of every secret); the mission image is
  scanned by trivy between build and push, report-only until a baseline is triaged, results in
  code scanning only; four Semgrep rules of ours with planted cases (`scripts/security/semgrep/`),
  each tested before the scan; Dependabot alerts on. Deferred: "every route behind auth" goes to the
  OpenAPI contract test (step 2b), and `alerts.json` to step 6 (it needs a private route to the
  mission). The control-plane image is built by Fly's remote builder and not yet scanned: the
  nightly scan of running images (step 7) covers it.

- **Step 1, 2026-11-23:** done (`f6f4403`). The gate's checker was measured on the 15 reports of
  2026-11-12..23: every blocking miss was a real error, and the documenter's reports pass. Written
  to magi-dev-1 while suspended (46 team files). appsec, code-reviewer and qa-lead are set
  `active: false` (operator), and their nine schedules were cancelled by the operator; step 6
  restores what it still needs of them: `appsec-weekly` 6af3075ee4a1ee91f06a4064, `appsec-monthly`
  6af3075ee4a1ee91f06a4067, `appsec-red-team` 6b039483ec9de27798ebdcb0, `code-review`
  6af3075ee4a1ee91f06a406a, `code-weekly` 6af49eefa61d0a1d91e5dc76, `code-monthly`
  6af49eefa61d0a1d91e5dc79, `trace-scan` (job, as code-reviewer) 6afb5d26fdd8cf397851f224,
  `qa-weekly` 6af641e04906a793dd9ed056, `qa-monthly` 6af641e04906a793dd9ed059. Also owed to
  step 6: correct what the paused agents now believe (the code reviewer's nonexistent commits
  and "recipientTags" bug, and the concern it passed to appsec; appsec's TB-30..33 and invented
  test names).

## Decisions (product owner, 2026-11-23)

1. The direction: scanners and generated tests decide; agents triage and propose, under
   mechanical acceptance; no certificates.
2. Agents' test code reaches the repository as a patch in the mission's shared folder that has
   passed the can-fail check; I review and commit it.
3. CI time: environment A on every push; B and C nightly, and C on runtime or Dockerfile changes.
4. A small model budget for the benchmark.
5. MAGI DEV until step 6: the documenter only (appsec, code-reviewer and qa-lead set inactive).
6. The tool suite of part 1: trivy configuration instead of hadolint; zizmor and Dependabot alerts
   added; Nuclei the primary dynamic scanner, ZAP dropped for now.
7. OpenAPI files generated from code (part 1b).
8. Environment B: a test-only sign-in (threat-model entry and tripwire with it), MongoDB as a
   service container.

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
