# Security assurance: scanners, a generated attack matrix, and agents that triage

**Status:** approved 2026-11-23; steps 1–5 done; step 6 designed 2026-11-24 (part 5), in progress.
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

### 5. What the MAGI DEV agents do (design agreed 2026-11-24)

The agents are rebuilt around three capabilities, with a fourth element around them that is code.

1. **Structured lists of items to check, from the automated suite.** Each item is one question
   with a known source: a code-scanning alert, a Dependabot alert, a trace finding, an open
   matrix cell, an entry point changed in the day's diff. No agent decides what to look at by
   browsing the code.
2. **A sub-agent with a clean context (the worker, `Investigate`).** It acts as the calling agent, with its shell and tools, but starts with no history. The code it reviews is a read-only reference copy kept by a platform task (decisions 15–16), so nothing it does can change the code under review; beyond that it holds the agent's own powers, the exposure the threat model already assumes for any agent reading hostile content (TB-8). It is given:
   a skill for the kind of item (what to look for, what counts as evidence, the answer format);
   a briefing for that item generated by code, not written by hand (from the trace: the entry
   point, the operation it serves, the invariants that apply, its files, the test that covers
   it); the agent's shell over the reference copy to fetch more on demand; a model. The context stays small on
   purpose: focus is what makes a model find things (8 runs in 100 with ~27K tokens of focused
   code, 1 in 100 with ~100K). Its answer is JSON.
3. **The catalog drives the work, and agents propose catalog changes.** Most items are a
   disagreement between the code and the catalog. Each answer is one of: the code is wrong (a
   finding), the catalog is wrong or incomplete (a catalog proposal), or neither, with the
   evidence. Agents also propose new attack classes and invariants. Proposals go to the sponsor,
   who validates the catalog (see [software-factory.md](../software-factory.md)); agents never
   change it.
4. **Code runs the pipeline and accepts the answers.** A job script, not the agent, runs the
   workers, compares their answers, calls the refuter and runs the acceptance checks: every cited
   file, line, test and commit exists; quoted code matches the file at that line; the subject
   beside a commit hash is that commit's; above low severity, a finding comes with a script or
   test that runs. A report that fails is not counted, and the misses go back to its author. The
   long-lived agent is a coordinator: it picks items, starts the job, files what survives
   (privately), and keeps the register.

**Sampling, parsimoniously.** Most items turn out to be nothing, so cost follows findings, not
items:
- **One run per item by default.** A candidate finding triggers confirmation: for triage
  questions ("is this alert real?") two more runs, kept when two of three agree; for discovery
  questions ("break this open cell") every candidate is kept and must survive the refuter.
  Invented evidence rarely repeats across independent runs; real finds can also be rare, which is
  why discovery keeps single candidates and relies on the refuter and acceptance instead of a vote.
- **Samples spread over time.** An unchanged item is reviewed again on a rotation; each later
  review is another independent sample. Code that keeps changing is reviewed because it changes.
- **Frequency by risk.** Each item belongs to a risk class with a maximum age between reviews
  (table below, values set by the sponsor). An overdue item shows in the register.
- **Once a day, not on every push**, so code changed five times in a day is reviewed once.
- **A daily budget and a priority queue:** new alerts and changed code first, then the most
  overdue items. What the budget does not reach waits, visibly.
- **A cheaper model first and a stronger one to confirm**, only if the benchmark shows the cheaper
  model's misses are rare enough.

| Risk class | Items | Maximum age (proposed; the sponsor sets it) |
|---|---|---|
| Boundary | Cells and findings on a trust boundary, a `sec.*` invariant, sudo, a request folder, authentication | 2 weeks |
| Platform | Other entry points, scanner alerts on shipped code, dependencies that ship | 1 month |
| Ordinary | Documentation, development-only dependencies, code no entry point reaches | 2 months |

**Fingerprints: not re-assessing what has not changed.** The pattern is the build cache's (Bazel,
Gradle, Nx, Turborepo: hash every input of a step, reuse the output when the hash matches) and
SARIF's finding fingerprints (one finding's identity across commits). No library does it for
model verdicts; it is built from small parts:
- **The item's identity** from its source: the alert number, the SARIF fingerprint, the advisory
  and package, the matrix cell, the trace's finding key.
- **Its dependencies, each with its own hash:** the code the workers actually read (from their
  recorded tool calls, not what they say they read); the guard functions the catalog names for the
  invariants in question; the text of those catalog entries; the skill, the model and the pipeline
  version.
- **The fingerprint** is the hash of that sorted list. Unchanged: the stored verdict stands.
  Changed: the item enters today's queue, and the worker is told which dependency changed.
- **Granularity:** file level first, from git's own content hashes (`git rev-parse <commit>:<path>`),
  at no cost; function level (the TypeScript compiler the trace already uses; tree-sitter for
  Python and shell) when file level is shown to over-invalidate.
- **The sponsor's decisions are remembered the same way:** a rejected finding or an accepted
  exception is not raised again until its fingerprint changes.
- **The limit:** a dependency nobody read and the catalog does not name is missed. The rotation
  covers it, and the rate at which a rotation review overturns a stored verdict says whether the
  fingerprint is too narrow.
- **Kept privately** in MAGI DEV's mission: a verdict on a security question is not published.

**The threat model, connected (agreed 2026-11-24).** Today it is the richest security document and
the least connected: 26 boundaries and their STRIDE rows by hand, each row's status (✅, ⚠️, ~) a
claim in prose (91 ✅ rows name no test), the matrix's rows carrying operations but not boundaries,
the invariants' `enforcedBy` saying "a test" without naming it. Phase 0's appsec kept it in step
with the code from memory and invented TB-30..33. Two mechanical links:
1. **Every matrix row names the boundary it crosses**, from a mapping in the matrix generator (the
   Tool API to TB-5; job and schedule request folders to TB-4 and TB-7; app requests to TB-24; the
   apps host to TB-26; an agent's OS user to TB-3 and TB-4; the machine on the network to TB-23;
   and so on). The matrix reads per boundary, and the boundary risk class is assigned by code.
2. **Every ✅ row cites its proof**, a matrix cell or a named test. A test counts the rows without
   one ("claimed") as a ratchet that may only go down; the 91 rows get their proof over time.

Then the threat model is both a source and a destination of the pipeline:
- **Items from it:** each ⚠️ row and open finding ("is it still open?"); each claimed ✅ row (a
  discovery item: write the cell that proves it); a new boundary's entry points become matrix rows.
- **Proposals back to it:** new rows, status changes, new attack classes and boundaries, verified by
  Claude Code and accepted by the sponsor, like catalog proposals. A cell that stops holding turns
  its row into a candidate ⚠️ with the failing test as evidence.
- **Findings stay private until fixed:** anything above low severity stays in MAGI DEV's register
  and reaches `findings.md` when fixed or accepted as a known risk.
- **Fingerprints include the boundary's STRIDE rows**, so a changed row re-opens its verdicts.
- **Kept by people:** the narrative, the STRIDE analysis of a new design (`/threat-model` at design
  time), and accepting residual risk. The phase-0 drift sweep is retired: the links find drift.

**The roles:**
- **appsec** coordinates the security outputs (code scanning, Dependabot, the image scan, the
  nightly community scan and DAST) and extends the matrix (attack classes, tests for open cells).
- **The code reviewer** reviews changes through the same workers, aimed at test gaps, its only
  consistently real output in phase 0.
- **The QA lead** turns journeys into proposed test cells.
- **The documenter** keeps its shape; "claimed" and "the record exists" are not evidence.
- No certificates anywhere: "APPROVE", "all controls hold", "held against N attacks" and
  "no drift" leave the skills, and the self-scored KPIs are retired.
- Agents still cannot run the repository's tests or push (deliverables D and B): a proposed test
  arrives as a patch, and Claude Code applies it and runs its can-fail check (decision 2).

### 6. Measurement

- **A known-answer benchmark**, run offline on every change to the pipeline or the agents' skills:
  #96's items, F-082 at `16bba51`, and historical security fixes replayed at the commit before
  each fix. Scored by code: which known answers each configuration finds, and at what cost. A role
  is switched back on only after it scores.
- **Model choice from the benchmark:** GLM 5.2 against a stronger model for the worker and the
  refuter, not chosen on price.
- **In production:** per run, how many findings passed acceptance, how many Claude Code verified
  and how many the sponsor accepted (the equivalent of Bugbot's resolution rate); and how often a
  rotation review overturned a stored verdict.

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
| 6 | **MAGI DEV redesign** (part 5): 6a the worker: platform tasks (task kinds shipped in the image, run by the daemon as a `magi-platform` user through one root-owned wrapper, chosen and scheduled by the mission's config) with `git-mirror` as the first kind, keeping a read-only reference copy of the repository; and `Investigate`, a clean-context sub-agent tool acting as the calling agent with its shell, over that copy, callable by agents and by jobs through the Tool API; 6b the pipeline as a job script (sampling, refuter, acceptance) and the fingerprint store; 6c the inputs: code-scanning and Dependabot alerts read through a control-plane proxy (never the public repository or a CI artifact), and the threat model connected (boundaries on matrix rows, proof cited by each ✅ row, a ratchet on claimed rows); 6d the known-answer benchmark and the model comparison; 6e the roles and skills rewritten, schedules restored per role, the paused agents' false beliefs corrected; 6f the production measures. | 5–6 days |
| 7 | **Fly runbook** for the operator's probes (Nuclei network templates) and the deployed-configuration checks, and the detections list from the security-testing item, with G-5 alerting where needed. | 1–2 days |

About 17–21 days in all. Steps 1–2 pay off whatever else is decided; 3–4 give the coverage
figure; 6 depends on 1 and 3.

### Progress
- **Step 6a, platform tasks, 2026-11-24:** `mission.platform-task` built. Kinds ship in the
  image (`/usr/local/sbin/magi-task`, root-owned, its own argument checks); the mission's top-level
  `platformTasks` (from its template at creation, never from a config editor or an inline config)
  chooses kind, schedule and parameters; the daemon runs each at boot and every `everyMinutes` as
  `magi-platform` (no secret, not in `magi-shared`, one new sudo rule), never twice at once, with a
  `platform-task-failure` anomaly after three failures in a row. First kind `git-mirror`: a
  GitHub repository kept at `/var/lib/magi/reference/<name>` (a bare mirror, snapshots per
  commit, an atomic `current` link, `status.json`), readable by agents and writable by none.
  Threat model TB-27 (its rows cite their proof); sandbox PLAT-1..4: 24 of 24 cells held, locally
  and as CI's gate.
- **Step 6a, Investigate, 2026-11-24:** `agent.investigate` built, for agents and on the Tool API
  (`investigate`) for pipelines run as jobs. One question, a clean context (only a skill file, a
  briefing, the question and a JSON Schema), the calling agent's shell, its budget and spend-cap
  pause; the reference copy's commit returned with the answer; an answer that does not match the
  schema gets one repair turn, then the call fails. Disabled for the mission copilot, like
  Research. 6a is done; next, 6b: the pipeline and the fingerprint store.
- **Step 5, environment B and Nuclei, 2026-11-24:** `scripts/security/stack/` starts the
  control plane's own image on an internal Docker network (no route out) with a MongoDB container
  and two test tenants through a new test-only sign-in (`AUTH_TEST_USERS`, refused on Fly: the
  auth middleware cannot be built when `FLY_APP_NAME` is set; threat model TB-9). Nuclei (v3.11.1,
  pinned by digest) runs four passes: controls that must match; six templates of ours
  (`scripts/security/nuclei/`: cross-tenant, no credential, headers, exposed files, source maps,
  error leaks), each proven to match a planted leaky server; the community templates (v10.5.1,
  checksum-pinned, signatures enforced: 1,170 exposure and misconfiguration templates plus CVEs);
  and DAST over the 62 OpenAPI routes as a tenant on her own mission (57 templates, ~2,500
  requests). First run: one finding of ours (the cockpit named its framework, `X-Powered-By`;
  fixed), nothing from the community or DAST passes. Nightly in CI (`security-nightly.yml`);
  counts in the log, findings in code scanning. Not done, by decision: Nuclei "lightly against
  dev" (dynamic scanning stays local; Fly's acceptable use). Still to come in environment B: the
  apps host and a mission in local-execution mode.
- **Step 5, fast-check, 2026-11-24:** properties over what agents, models and tenants write, in
  the ordinary unit suite with a fixed seed (`FAST_CHECK_SEED` explores elsewhere):
  `resolveInside` (no returned path's real location leaves the root, through `..`, symlinks in and
  out, dangling links), app requests (only files in the owner's workdir or `shared/`), schedule
  files (only the author's jobs, only roster recipients, a spoofed author refused rather than
  rewritten), tool arguments (what a tool receives always matches its schema), team-file paths,
  the apps host's tickets and sessions (refused after any one-character edit, as the other kind,
  under another key, or expired), and the cockpit's markdown renderer (no script, handler,
  dangerous URL or stray style in the parsed DOM). Each property also asserts it accepted some
  inputs, and each guard was mutated to prove its property fails: 15 mutations, all caught but
  two equivalent ones (a session has no nonce, so the ticket's kind check has a backup). The
  first runs found two vacuous properties (random junk never reached the accepting branch) and
  one gap in the markdown cases (no quote inside an attribute such as an image's alt text).
- **Step 4, second batch, 2026-11-24:** nine more sandbox cells, 20 in all, each holding with a
  working control (run locally first, now that Docker answers from WSL): a job request planted as
  a hard link (JOB-3); a schedule file that runs a job as another agent (SCHED-1); another agent
  reading a running job's Tool API token from its process (TOOL-2); the token used after its job
  exited (TOOL-3); platform secrets in a job's environment (ENV-1) and through the three sudo
  wrappers when the daemon's own environment is passed to them (ENV-2); one agent reaching
  another's app on loopback (APP-1); `magi-net` given ports, uids or words it must refuse
  (HELPER-1); the wrappers run as root (HELPER-2). The matrix credits them: 323 cells, 156
  covered, 162 open. The first local run reported APP-1 broken: the harness's probe mixed
  bash's error text into its answer; the attack had been refused.
- **The matrix as a document, 2026-11-24:** `docs/security/attack-matrix.md`, generated by
  `npm run docs:matrix` (`scripts/security/matrix/matrix.mjs`) from the four OpenAPI files, the
  trace's entry points (copied to `docs/security/entry-points.json`) and two platform rows (an
  agent's OS user, the machine on the network): 309 cells, 127 covered, 177 open, 5 not applicable
  with their reasons. A cell names the test that attacks it, never its result (the repository is
  public). `attack-matrix.unit.test.ts` fails when the document is stale, when a covered cell's
  test does not exist or does not carry the cell's name, or when an HTTP operation or entry point
  has no cell (it found the apps host's `/healthz` missing on its first run). The open cells are
  the work list for the next steps: the agent tools' path escapes, the Tool API across agents,
  the request folders other than jobs, the copilot actions' confirmation, the triggers.
- **Step 4, first cut, 2026-11-24:** `scripts/security/sandbox/` starts the image just built (with
  a MongoDB container, `FLY_APP_NAME` set) and runs 11 cells as the agent users: OS isolation between
  agents and from the daemon (files, environment, private state), sudo, job spoofing and symlink
  plants, every monitor route without its token, the monitor's file routes by traversal and symlink,
  the Tool API without a token, and the firewall from another machine. Each cell has a control that
  must succeed. In CI before the push; a gate since its second run held 11 of 11 (the first run's
  two misses were the harness: a 60-second job poll, and no `pgrep` in the image). Counts in the
  public log, details in code scanning. The monitor-server cells of step 3 live here (they need the real users and MongoDB).
- **Dependency pass, 2026-11-24** (Dependabot's first 27 alerts): vite 6.4.6 everywhere (one copy,
  pinned at the root so the cockpit and vitest agree), katex 0.18.2 (the cockpit renders agent-written math), the stale picomatch
  exception dropped (no longer reported), `parked/` removed (audit item DEAD-PARKED). `npm audit fix`
  was tried and reverted: it reshuffled the lockfile into a vulnerable production `undici` path.
  Left, each needing a major upgrade, for their own task: vitest 3 → 5 (the two critical tinypool
  alerts, development only, never shipped); firebase-admin 14, exceljs and Stagehand's AI SDK
  (moderate and low, indirect: uuid, google-gax, provider-utils); mermaid 12 (its own katex copy).
- **Step 3, first slice, 2026-11-24:** the control plane's HTTP cells, generated from
  `docs/api/control-plane.openapi.json` and run against the real `createApp` with a fake database and
  two mocked tenants (`attack-matrix-http.unit.test.ts`): no credential on 56 operator routes (401,
  nothing written); a bad mission token on 4 mission-copilot routes; another tenant on 30 routes
  naming a mission or an app, with the oracle "tenant B's answer for A's mission equals its answer
  for a mission that does not exist, nothing of A's leaks or changes". Every cell is proven by a
  mutation of its guard (sign-in made a pass-through, any mission token accepted, the tenant rule
  removed): 29 tenant cells proven, 1 untestable here (`DELETE`, refused to everyone). On the way, the
  tenant rule had four copies (proxy, platform routes, resource routes, the apps' open path): it now
  has one home, `auth-scope.ts`, so a fix or a mutation reaches every caller.
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

## Decisions (sponsor, 2026-11-24)

9. Step 6 before step 7: step 7 gives the redesign no input it needs.
10. The agents are rebuilt around the three capabilities of part 5 (structured items, a
    clean-context worker, catalog-driven work with catalog proposals), with code running the
    pipeline and accepting the answers.
11. Parsimonious sampling (one run by default, confirmation only for a candidate, rotation by risk
    class, a daily budget) and fingerprints to skip what has not changed.
13. The threat model connected to the pipeline: matrix rows name their boundary; each ✅ row cites
    its proof, with a ratchet on claimed rows; ⚠️ rows, open findings and claimed rows become
    items; agents' changes to it are proposals the sponsor accepts.
15. The worker (`agent.investigate`) runs as the calling agent, with its shell, over a read-only
    reference copy of the repository; no lower-privileged twin user for now (it can be added
    later without changing the copy).
16. Platform tasks (`mission.platform-task`): kinds shipped in the mission image only, never code
    sent at run time; the control plane chooses the kind, schedule and parameters, checked
    against the kind's schema; tasks run as a `magi-platform` user without the daemon's secrets,
    through one root-owned wrapper and one sudo rule; agents read their output and never write it.
    Only the platform admin changes a mission's platform tasks (owners may be allowed later).
    The first kind is `git-mirror`, which keeps the reference copy.
17. Open: the risk classes' maximum ages (proposed in part 5); the order of restoring roles
    (proposed: appsec, then the code reviewer, then QA).

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
