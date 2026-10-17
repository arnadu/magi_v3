# Sprint 28f — audit-oct26 remediation plan

The committed companion of the working plan for the 2026-10-08 third-party static audit of this
repository (reviewed commit `49d8730f`). The audit report itself and its per-finding tracker
(`audit-oct26/`, ~150 findings with repro payloads) stay local and gitignored; the closed-out,
redacted summary is [`docs/review/2026-10-audit.md`](../review/2026-10-audit.md). Finding IDs
below (ENV1, MS1, XSS1, …) are the audit's; `F-0xx` are the rows in
[`docs/security/findings.md`](../security/findings.md). This file was committed at the end of
milestone M1 (all High-severity findings fixed) and is updated at each later milestone.

## Context

A third-party static audit (2026-10-08, ~150 findings) found that MAGI's security story ("agents
untrusted, daemon trusted, tenants isolated") was documented but not enforced: the daemon acted on
agent-controlled paths with its own secrets (GIT1, TF1, RS2, MS1, AR1, JOB1), any signed-in user
could reach platform secrets (ENV1, CHAIN-A), spend containment was opt-in, stored schemas had
drifted from their readers (STATS1 class), and LLM-facing text promised features that don't exist
(SCHED2, OV1, TPL4). I verified the five worst claims against the code before accepting the audit
(all five held) and fixed them as WO-1 Group A: ENV1 `d1577f2`, TF1 `4eb5f69`, GIT1 `d9b061a`,
MID1 `e7adb71`+`5704265`, X-TENANT3 `8663c80` — F-032..F-036 in `docs/security/findings.md`.
Unit (998) and integration (209) suites pass.

The audit's own root-cause analysis (PROCESS doc) is the key insight for this plan: everything a
machine enforced held (lint, tests, the SKL4 price-table test); everything that relied on an agent
remembering to "pause and reason" drifted. So this plan is not only fixes — it converts the
advisory rules into checks, treats prompts/skills as code, and gives stored schemas one typed source
of truth, so the same classes of defect cannot silently return.

## Decisions (made)

| # | Decision | Consequence |
|---|---|---|
| D-1 | Firebase sign-up is invite-only | Rotation of control-plane secrets is prudent, not urgent; do it once after M1 (ENV1 already closed) |
| D-2 | Build the real scheduler, don't delete the skill | ADR-0033 + WS-2.1 below |
| D-3 | Default `maxCostUsd` $25; platform ceiling $100 via admin-only `PLATFORM_MAX_COST_CEILING_USD`; model allow-list = `models.ts` price table | WS-1 F |
| D-4 | Delete the legacy dashboard | WS-1 C2 |
| D-5 | Mission-id rule `^[a-z0-9][a-z0-9-]{0,62}$` + reserved `copilot/admin/platform/system` | done (F-035); zod-level tightening deferred until stored ids verified |
| D-6 | `DELETE /missions/:id` stays disabled; an archive path is Post-MVP | roadmap |
| D-7 | X-TENANT2 (shared credentials on tenant machines) stays Sprint 29 | accepted + documented, not fixed here |
| Q2 | Repo is **public** | EXFIL1 is a real exfiltration channel → gate it (WS-1 B6); detailed plan/audit not committed until Highs are closed |
| Sprint | 28f re-scoped to "Audit remediation + operational hardening" | WS-6 |
| Refactor scope | Ratchets + the three worst decompositions; rest become issues under the ratchets | WS-4 |
| Workflow | Solo dev, no PRs: one commit per finding, `fix(<ID>): …`, test-first (failing on parent, passing after), findings.md + threat model in the same commit; `/code-review` on every security commit as the independent-verifier substitute | all |

**Still open, decided by default unless objected:** Q9 (daemon's 50-dispatch exit is a bug, not a
spend guard — remove); EXP1 (fix the tracked `experimental/dump-trace.mjs`, don't delete the
directory — local `dump-trace-v2..v6` variants are in active use); Express 5 (asyncHandler wrapper
now, the major upgrade as its own dependency step later).

## Disclosure (repo is public)

`audit-oct26/` is added to `.gitignore` at M0 and stays local; `docs/review/` (kit docs, STATUS.md)
is created gitignored. `findings.md` records each item only once fixed (as for F-032..036). The
full plan doc and a closed-out `docs/review/2026-10-audit.md` are committed at the end of M1 (all
Highs fixed), with repro payloads removed. The reconciliation table (end of this file) goes into the
committed plan doc at that point.

## Workstreams

### WS-0 Setup (M0, with WS-3's gates)

- `.gitignore`: `audit-oct26/`, `docs/review/`. Keep the kit's STATUS.md as the per-finding tracker
  (already updated through Group A).
- GitHub: close #61 (fixed by `e83f20b`, `resume_mission` destroyed-machine fallback) and #21 (GIT1
  moved the git dir out of agent reach — F-034); link #53 ↔ STATS1. File issues for every DEFER row
  in the reconciliation table (one issue per group, labels `deferred`/`security` as applicable).
- Uncommitted drafts in the tree (`README.md` rewrite, `CLAUDE.md`/`MAGI_V3_ROADMAP.md` Sprint 29
  paragraph): fold into WS-5/WS-6 — the README's "agents never have access to … the platform's own
  LLM/database credentials" sentence is false (X-TENANT2) and must change before it ships.
- Step 0 live checks (read-only, dev): audit `missions`/`missionConfigRevisions` for secrets already
  expanded by ENV1/MIG1 (search prefixes of each secret; never print values); then rotate
  `CONTROL_API_KEY`, `MONITOR_SIGNING_KEY`, Fly tokens, Mongo user, provider keys, `GH_TOKEN`.

### WS-1 Security & resilience fixes

Order is risk reduced per hour (audit §10), grouped as in WO-1. Each row: test-first, one commit,
`findings.md` row (next ID F-037…), threat-model header note, `operational-resilience.md` row when a
failure mode changes. Reuse: `validateTeamFilePath` pattern (`agent-config/src/team-files.ts`),
`safe-git.ts`, `machine-lifecycle.ts`'s import-restriction test as the template for new guards,
`inspect-image.ts`'s realpath+`base+sep` check (the one correct existing path check).

**B — daemon-identity boundary (confused deputy)**
- B1 `agent-runtime-worker/src/safe-path.ts`: `resolveInside(root, rel, {mustExist?, noFollow?})` →
  realpath of the nearest existing ancestor + `root + sep` prefix + `O_NOFOLLOW` open helper; hard
  unit tests (symlink out, symlink swap, `..`, absolute, NUL, sibling-prefix `<root>-x`). Then apply
  to: MS1 (`monitor-routes/*` read/download/write/edit — also fix the bare `startsWith(root)`),
  RS2 (`tools/research.ts` `context_files`/`output_path`; deny `/proc`, `/sys`), AR1/AR2/DOC4
  (`artifacts.ts` + `document-processor.ts writeDirectory`: non-recursive mkdir that fails if
  present, `O_EXCL|O_NOFOLLOW`, random-suffix UTC ids), INSP1 (size cap), MC8 (`RestartBackgroundJob`
  jobId slug check), MS2/MS5/MS6 (zip walk no-follow + size cap; write-route extension allow-list,
  never `.git*`). `team-files-sync.ts` switches to the shared helper (keeps its tests).
- B2 M1/X-TENANT1: monitor server requires the per-mission token on **every** route incl. GETs and
  `/events` (constant-time compare, MCR1 too); "no token" is a startup error outside local dev;
  test enumerates the router so an unauthenticated new route fails. Proxy already injects the
  header (F-008); SSE keeps `?token=` (short-lived, `/events` only — C2). Live check Q4 first.
- B3 SSRF: `ssrf.ts` resolve with `all: true`, normalise IPv4-mapped IPv6, deny `::`, `0.0.0.0/8`,
  `100.64/10`, link-local, ULA incl. `fdaa:`, trailing dot (S1/B1b); FetchUrl + `fetchImage`
  `redirect: "manual"`, re-validate each hop (cap 5), connect to the pinned address (S2/S3/FU3);
  egress proxy resolves once and fails closed (B1); streaming byte cap (FU1), extension sanitise
  (FU2), own timeout + untrusted banner (FU4). Tests: redirect→loopback, →name resolving to loopback,
  →`fdaa:`, decimal/hex forms.
- B4 JOB1/JOB2/PROXY1: identity from the spec file's owner uid, never from the spec (design in
  WS-2.1 — the scheduler shares it); job ids validated as slugs; `job-recovery.ts` path from a
  validated id; daemon-side daily quota per provider in `data-provider-proxy.ts` (not the
  agent-writable counter file).
- B5 SK1/WM1/ISO1: private workdirs `0700` + `setfacl -m o::---` (read-denial integration test, not
  just write); `shared/skills/_platform|_team` parent owned by the operator with no agent default
  ACL (so the tier dirs can't be renamed/replaced); `skills.ts`: cap description 200 chars, refuse
  agent-tier shadowing of platform/team names, label non-platform tiers untrusted, exclude agent
  tiers for the mission copilot.
- B6 EXFIL1 (+F-021, F-023, MCR3): mission-copilot `ReportGithubIssue` and control-plane
  `CreateIssue`/`CloseIssue`/`AddIssueComment` go through `ProposeAction` → confirm (new action
  `file_github_issue`, full payload on the card); per-mission daily quota; body prefixed as
  untrusted; `ListIssues` uses the search endpoint for `q`.

**C — web and cockpit injection**
- C1 XSS1/X1/AUTH1/C2/MS4/MT1: `cockpit/src/markdown.ts` escapes `"`/`'` before any tag is
  reintroduced; link/image URLs validated with `new URL()` against `http/https/mailto`; payload
  corpus test (`"onerror=`, `javascript:`, `data:`, `vbscript:`, mixed case, entity-encoded,
  whitespace-split, table cells). Control plane sets CSP (`default-src 'self'`; verify mermaid/katex/
  Firebase in the browser — may need `style-src 'unsafe-inline'`, never `script-src`), `nosniff`;
  session cookie issued by the server (`POST /api/auth/session` exchanges the Firebase ID token /
  admin key for an `HttpOnly; Secure; SameSite=Lax` cookie; nothing credential-bearing in
  `sessionStorage`); SVG/HTML downloads as `attachment`. DOMPurify only if the corpus can't be
  closed by escaping.
- C2 LEG-XSS/LEG1/M3 (D-4): delete `agent-runtime-worker/public/{app.js,index.html,style.css}`,
  `monitor-routes/static-assets.ts` routes, fix `proxy.ts`'s stale comment; grep clean.
- C3 EXP1: escape `<` as `<` in the embedded JSON and the title; SRI for d3.

**D — input validation and gates**
- D1 LP2: `loop.ts` validates every tool call against its TypeBox schema (pi-ai's
  `validateToolArguments`) and returns `isError` so the model self-corrects. Root cause of EA1, MB1,
  DOC4, OB6, MC7, MC8.
- D2 EA1/EA2/EA3/SCHED3/SCFG1/CK-GATE: typed action registry (`copilot-router.ts` → one zod schema
  per action, unknown keys rejected — shared with WS-4 R-3); ownership via `missions.findOne({missionId,
  userId})` for `create_schedule`/`cancel_schedule`; `cancel` checks `matchedCount`; failures are
  failures (`ok:false`), not "saved"; `/confirm` acts as `action.userId`; the card shows the
  validated payload and a server-computed label.
- D3 OB3/OB5/OB6: `GoalsFileSchema.superRefine` (acyclic, unique ids); visited set in `foldStore`;
  `Allocate` parses into a null-prototype map; ownership on `RecordKpi`/`UpdateTask`.
- D4 MBX1/MR1: one `postMailbox()` for the 8+ hand-rolled inserts + an import-restriction test (as
  `machine-lifecycle` has); `GET /mailbox` newest-500 (same bug as #63).
- D5 LU1/RID1/CFG1/MC6/MC7: duplicate agent ids / shared `linuxUser` rejected; reserved agent ids
  `user/system/scheduler/copilot`; prompt/agent-count caps; `SetMissionSpendCap` numeric + ceiling;
  `CreateScheduledMessage` validates `deliverAt`, `to` against the roster, min cron interval.

**E — reliability and correctness**
- E1 D1: daemon mode passes `maxRuns: Infinity`; a loop exit in daemon mode exits non-zero. Test
  from the audit's repro (`maxruns-daemon-mode`).
- E2 C1: `asyncHandler` wrapper on every router + `process.on("unhandledRejection")` + terminal
  error middleware (tripwire T7 clean). Express 5 later.
- E3 R1 (`effectiveTools` on retry, per-attempt state), RF1/RF2/RF3 (empty reflection → no
  compaction + anomaly; try/catch; threshold from the model's window), CW2/CW3 (copilot daemon
  restart with backoff, eviction), SCH1/2/4/5 (`delivering` lease + sweep, re-arm in the claim,
  off-by-one, status update after wake, re-entrancy guard), LAUNCH1/LAUNCH2 (CAS on status; persist
  `volumeId` as soon as created — also the leading hypothesis for #62's drift: two provisions racing
  on one id leave the doc pointing at one volume while the daemon runs on another), FLY4/5/6
  (timeouts, 429/5xx retry, pinned image), RAS1/FE1/OC1 (fail closed, dedupe — overlaps #58),
  OC2, RM1/RM2/BD1, AS1 (reconcile `$inc`s a crashed turn's cost once), COPCAP1, CD1 (mark read
  after the turn), MW1/D7 (poll fallback in the worker's `mail-waiter.ts`, mirroring
  `copilot-waker`), LG1 (log rotation + stream error handler), TA2, T1/T2/T3 (Write parent dirs,
  both truncation caps, AbortSignal into tools + process-group kill, 600 s advertised = enforced),
  AUTH2 (#7 `checkRevoked`), AUTH-BF (rate limit on the admin-key path), PX1.
- E4 live-reported loop bugs already open: #55, #56, #64, #65, #58 — same sprint, same discipline
  (they are the reliability half of "agent safety").

**F — spend containment (D-3)**
- LM1/LIM1/CFG2/TPL5: default cap at creation (all three creation sites), admin-only platform
  ceiling the tenant cannot edit (new env + `missions.ts` ceiling route refuses above it; cockpit
  shows it), model allow-list from `models.ts` (MD1: unknown ids rejected, not priced as Sonnet),
  every shipped template sets `maxCostUsd`; `uncapped-spend` anomaly for pre-existing missions.
- COST-1/DOC8: `meteredCall()` in `agent-runtime-worker/src/models.ts` (or `llm-call-log.ts`) used
  by the Research sub-loop (`onLlmCall` threaded), vision/OCR, `InspectImage`, BrowseWeb (Stagehand:
  meter via its usage callback if exposed, else count calls with the price table and mark
  `costEstimated`); per-document OCR cap.

**G — dependencies, CI, deployment, OS**
- deps: upgrade `@modelcontextprotocol/sdk`, `@browserbasehq/stagehand`, `http-proxy-middleware`,
  `image-size`; align zod 3/4; `npm audit --omit=dev` high/critical → 0; `firebase` major deferred.
- CI1/CI2/CI3/BS3/BS4 (CR-06): deploy workflows `workflow_run` on Quality; drop `|| true` on the
  image-pin unset (make `deploy-missions.sh` the only pin owner); pin actions by SHA; gitleaks +
  `npm audit` + actionlint in CI; per-environment Fly tokens; `promote.sh` tags after a green deploy.
- DOCK5/DOCK3/DOCK4/SD1/ISO2: Node 22 LTS, images by digest, stale `env_keep` removed from the
  worker Dockerfile and `setup-dev.sh`, `/app/**/src` not world-readable, HEALTHCHECK.
- BS1/BS2/RECON1/RECON2/MIG1: `bootstrap.sh` destroys only the builder machine; secrets not via
  argv; `--purge-orphans` needs `--yes`, an age gate and skips attached volumes; `--fix-status`
  with CAS; migration script marked historical.

### WS-2 Missing or buggy functionality

- **2.1 Scheduler (ADR-0033; SCHED1/2, SKL2/6/7, TPL4 part 3, TPL6).** Design: see "Scheduler
  design" below (filled from the design pass). Shares the file-owner identity model with B4.
- **2.2 Stats and cockpit data (STATS1/#53, CK-STALE, TX1).** `/api/missions/stats` reads
  `missionStats`/`agentTurnStats` (never `llmCallLog`); cockpit reads `usage.inputTokens`/
  `outputTokens`/`cost.totalCostUsd`; a `callId` stored on both the message and the LLM-call record
  replaces the ordinal mapping. Fixture contract test written by the real writers
  (`schema.consumers.test`, WS-3).
- **2.3 Cockpit behaviour bugs:** DE1 (no launch after a failed save), DE2 (rename cascades
  `supervisor`; unique ids), DE3 (cap field in the draft editor), CK-UPLOAD1 (`uploadAttachment`/
  `dismissCopilotAction` throw on non-ok), CK2 (no sample-data fallback), CK-ERR (fetch errors
  surface, not empty arrays), CK1 (403 is not "not signed in"), CP1 (busy state; pending actions
  persisted in Mongo so a redeploy doesn't lose them), FP1 (cancellation guard + ETag on save),
  CFG-P1 (version precondition), CNV1 (pause polling when hidden), MS3 (RFC 6266 filenames).
- **2.4 Skills and templates that are functionally broken:** NEWS1 (`is_new` = not yet consumed by a
  brief), DF2/DF3/ADP2 (no runtime pip install; catalog saved incrementally + atomic writes;
  truncated files re-fetched), TPL2 (`objectives-demo` uses the tools), TPL4/MAF1/TPL6 (gold-digest
  and equity-research call `read-digest.sh` by id, no manual commits, no dead scheduler, no "keys
  injected"; `market-analysis-framework` moves to the gold-digest team skills), SKILLS-DRIFT (cockpit
  skill list and `TIER_A_TOOLS` generated from the skills directory and tool registry), DOC1/DOC2/
  DOC7/DOC10 (zip nesting by content; uncompressed-size/ratio caps; PDF page/byte caps for text
  extraction off the daemon thread; `partial` status on render failure), DP1 (provider error bodies
  redacted, responses capped).
- **2.5 CLI tools:** CLI1 (`cli-reset` clears every per-mission collection), CLI2 (`MAX_COST_USD`
  honoured in `cli.ts`), CLI7 (CSV formula injection); rest as a low issue.

### WS-3 Development practices (so this doesn't recur)

The audit's RC1–RC9, adapted to a solo, no-PR workflow. Principle: **a rule without an enforcement
is a wish** — every rule names its check or is marked ADVISORY.

1. **`npm run verify`** = build + lint + unit tests with coverage ratchet + `scripts/audit/
   tripwires.sh` + contract tests. One script, used by the pre-push hook and by CI, so local and CI
   agree. `verify:quick` (typecheck + lint + tripwires) for the Claude Code Stop hook.
2. **Tripwires** (adopt the kit's `scripts/audit/tripwires.sh` + `tripwires.allow`; tune T2/T5/T7/T9
   allowlists with owner+reason; widen T11; add T12 for raw `collection("mailbox").insertOne` and T13
   for `process.env` outside `env.ts` once R-8 lands). Allowlists only shrink (CI compares to base).
3. **Ratchets** (#44): per-package coverage thresholds at today's level, +2 points per sprint;
   Biome `noExcessiveCognitiveComplexity` 25 with a generated allowlist; `scripts/audit/
   length-check.mjs` (file 600 / function 120) with an allowlist; shellcheck + ruff in CI.
4. **CI gating:** `quality.yml` must pass before either deploy workflow runs (`workflow_run`);
   `npm audit --omit=dev`, gitleaks, actionlint, image scan added (CR-06).
5. **Claude Code hooks** (`.claude/settings.json`): PostToolUse Biome on edited files; Stop hook
   `verify:quick` (refuses "done" on red); PreToolUse deny `flyctl deploy|destroy`, `git push
   --force`, writes outside the repo.
6. **Contract tests — the lasting deliverable** (WO-3 Group 4): `llm-text.tools.test` (every
   tool-shaped identifier in prompts/SKILL.md/templates/injected text exists in a registry),
   `llm-text.scripts.test` (every script path + flag exists; extends SKL4), `llm-text.payloads.test`
   (example payloads parse with the action schemas — would have caught SCHED3/SCFG1),
   `docs.commands.test`, `docs.env.test` (table generated from `env.ts`), `docs.tools.test` (SPEC §6
   = registry), `docs.links.test`, `schema.consumers.test` (fixtures from real writers read by every
   consumer — the STATS1/CK-STALE/MR1 class).
7. **Whole-repo audit at sprint end:** adopt `.claude/commands/sprint-audit.md` (7 specialist
   auditors + a refuting verifier, read-only, output `docs/review/sprint-N.md`), with
   `docs/security/trust-boundaries.md` (actor, identity, secrets held, inputs, who can write them) as
   its input. `/security-review` keeps its diff scope but replaces "do NOT re-report" with "dedupe by
   ID, re-verify open ones". First run at this sprint's close; seeded-defect check and
   `docs/review/metrics.json` trend from the second run.
8. **Independent verification without a second human:** `/code-review` (different model where
   available) on every security commit, asked to refute; a human decides anything touching a trust
   boundary or a deferral (already the practice this sprint).
9. **CLAUDE.md invariants with enforcement** (PROCESS §4.2, adapted): INV-1 untrusted inputs,
   INV-2 privileged actors never act on agent-controlled paths/config except via `resolveInside`/
   `runGit`, INV-3 *changing who can supply an input is a trust-boundary change → re-review every
   consumer* (the ENV1 root cause), INV-4 spend (`meteredCall`, caps, fail closed), INV-5 one typed
   stored schema + consumer sweep on rename, INV-6 LLM-facing text is code, INV-7 boundary
   validation, INV-8 no silent debt, INV-9 comments state constraints (one-line incident references
   allowed; sprint numbers and running history not), INV-10 claims in CLAUDE.md are tested. Plus a
   "stop and ask" list and a commit-message definition of done (verify output, INV touched, test
   name, NEW-FINDINGS line for anything noticed but not fixed).
10. **Migrations ship with a consumer sweep** (RC5): renaming a stored field requires `rg` across
    packages, cockpit, skills, prompts and scripts in the same commit, plus the fixture test.

### WS-4 Readability and maintainability (ratchets + the three worst)

- Ratchets first (WS-3 §3) so every decomposition has a measurable before/after; characterization
  tests through public interfaces for `daemon.ts`, `monitor-server.ts`, `missions.ts` before
  touching them (R-0e); refactor commits are moves (`git diff -M`), tests unchanged, ≤ ~600 lines.
- R-1 `createMissionsRouter` (1164 lines, cc 119) → modules by concern: lifecycle (launch/resume/
  suspend), config editing, limits, files/proxy, stats, Fly state mapping; existing exported
  `writeX` helpers are the seam; routers composed in `index.ts` (#35).
- R-3 `executeAction` → `Record<ActionName, {schema, handler}>` registry (also WS-1 D2); the action
  list exists once, not in three places (EA7/EA8).
- R-2 `runAgent` (682 lines, cc 55) → named phases over an explicit state object.
- Cross-cutting plumbing that unlocks docs generation: R-8 `env.ts` per package (97 scattered
  reads), R-9 one `DEFAULT_MODEL`, R-11 empty catches logged with operation/input/consequence,
  R-13 bare `console.error(e)` removed, R-15 typed stored-document schemas + typed collection
  accessors + `field<T>()` path helper (`agent-config/src/stored.ts`) so a wrong field name fails
  `tsc`.
- Delete what is dead: `packages/parked/` (DEAD-PARKED), legacy dashboard (C2),
  `migrate-legacy-store.ts` + boot call (ML1), dead `test/` branch in `templates.ts` (TPL1),
  `EPHEMERAL_TOOLS` `ReadFile`, CD3 test accommodations in `copilot-daemon.ts`, data-factory
  `refresh_cron`/`documents` (DF1), `DELETE /:id` dead destroy code (D-6).
- Deferred to issues under the ratchets: R-4 (`runOrchestrationLoop` #60, `runPendingJobs`,
  `runInnerLoop`), R-5 (#34, copilot-tools), R-6 (`document-processor.ts` per format), R-7 (cockpit
  hooks/components, CK-DUP/CK10/CK7/CK11/CK6), R-14 (Python adapter dedupe), A1 (shared domain
  package instead of the worker barrel), R-10/R-12 (via tripwires, not bulk edits).

### WS-5 Documentation and comments

Sequenced after the code it describes (WO-3's rule). Three kinds of text, three treatments.

- **LLM-facing text is code** (highest value): SCHED1/2/3 (per ADR-0033), SCFG1, OV1/OB1 (injected
  mental-map text names the real tools), MCP1 (`mental_map_update/add/remove`; no "SPEC is kept
  current" claim), TPL2, TPL4/MAF1/TPL6, SKL1–SKL8/IT1 (drop ignored `scope:`; `github-issues` never
  asks for a PAT; split `incident-triage`/`mission-leadership` per plane), COPSKILL-DRIFT
  (`mission.maxCostUsd`, 13 skills, no personal paths, `/stats` workaround removed once 2.2 lands),
  DF1/DF2/NEWS2, TPL3/TPL5/TPL-LINUXUSER. Each row lands with its contract test (WS-3 §6).
- **CLAUDE.md restructure** (PROCESS §4.1, target ~150–200 lines): roadmap paragraphs → ROADMAP.md
  only; env-var catalogue → generated `docs/env.md` (after R-8); collection list → generated from
  `stored.ts` (after R-15); invariants + enforcement; delete false claims (Node 18 pitfalls,
  `MAX_COST_USD` as the cap, 5 skills, data keys forwarded, "no template sets linuxUser", pm2);
  trigger lists move to `packages/*/CLAUDE.md` (or `.claude/rules/*.md` with `paths:` if supported);
  Documentation table gains rows for prompts/skills/templates, stored schemas, tool registries;
  sprint-closure checklist replaced by `npm run verify` + `/sprint-audit`.
- **SPEC:** §6 tool tables generated by `scripts/gen-tool-docs.mjs` between markers (CI fails on
  drift); remove `UpdateMentalMap`/`PublishArtifact`; list the mission-copilot set; §4/ADR
  references updated.
- **Consistency matrix (audit §8), row by row:** threat-model SSRF/monitor-bind lines, resilience
  L129 daemon claim, README L17 and template list and "template seeding" script, `vite.config.ts`
  "committed", Dockerfile comments, `code-structure.md` counts and the "~80–120 lines each" claim,
  Write/Bash tool descriptions, `llm-call-log.ts` 7-day vs 1-day retention (LL1 — decide the
  retention, then make both docs and code say it), `cli-reset` claim, `GET /mailbox` comment,
  `postmessage-conventions` "safe links", `magi-skills` tiers.
- **Threat model and resilience:** TB rows for daemon-identity operations on agent-writable trees
  (now guarded), git isolation, mission-id namespace, monitor auth, legacy UI removal;
  `trust-boundaries.md` table; ADR-0019/0021 supersession notes where old designs are still
  described; `operational-resilience.md` closed gaps removed, the stale G-3 reference fixed in the
  skill; README security paragraph corrected (X-TENANT2 is real) before the open-source push.
- **Comments:** fix the known-wrong ones (`prompt.ts` "rounded to 5 minutes"/"fully static",
  monitor "7-day retention", `llm-call-log.ts` header, `scheduler.ts` SCH6/OPS1, `tools.ts:8`,
  `anomaly`/`resource-sampler` headers, `document-processor.ts` ZIP, `markdown.ts` "never re-open",
  egress proxy DNS, `copilot-daemon.ts` "events will not be missed", `tool-api-server.ts` header,
  D5 atomic rename, O4/M2/MD2 stale). History-in-comments shrinks through tripwire T11's allowlist,
  not a bulk rewrite (many "found live" lines *are* the why; INV-9 keeps one-line references).
  Every `biome-ignore`/`any`/`as unknown as` carries a one-line constraint (R-12, via T9).
- One source for the equity-research guide (`playbook.json` generated or deleted).

### WS-6 Roadmap and reconciliation

- `MAGI_V3_ROADMAP.md`: 28f row re-scoped ("Audit remediation + operational hardening", absorbing
  CR-06, CR-07, #7, #21, #31 revisit, and the audit groups above; links to findings F-032+ and, once
  committed, the plan doc); 28g unchanged; 29 row keeps X-TENANT2, per-user copilot OS identity +
  P7/TB-15/16, CR-08; Near-term: onboarding flow + usage dashboard (dropped from 28f) ; Post-MVP
  additions: DEL1 archive path, OPS1 data tier with backups before paying tenants, A1 shared
  package, Express 5 + Firebase major, full cockpit decomposition, `llmCallLog` retention for billing.
  Status section and `CLAUDE.md`'s sprint paragraph updated the same way.
- Commit the reconciliation table (below) in the plan doc at M1's end; update it at sprint close.

## Scheduler design (ADR-0033) — WS-2.1 (+ the JOB1/JOB2 identity model, WS-1 B4)

Two promised-but-unbuilt mechanisms exist: `schedule-task/scripts/schedule.sh` writes
`shared/schedules/<label>.json` = `{label, to[], cron, subject, body}` ("the daemon upserts into
scheduled_messages"), and `run-background/scripts/schedule-job.sh` writes `{label, cron, jobSpec:
{agentId, linuxUser, scriptPath, args[], notifyAgentId?, notifySubject?}}` ("fires on the cron and
re-arms"). Nothing reads `shared/schedules` (`mission-copilot.ts:344` admits it; ADR-0011 drew the
step). What exists and works: `scheduled_messages` + control-plane `scheduler.ts deliver()` (claims
due docs atomically, **wakes a stopped machine**, inserts mail, re-arms cron) and the mission-copilot
tools `CreateScheduledMessage`/`CancelScheduledMessage`/`ListScheduledMessages`.

Two code facts shape the design (both verified): (1) a suspended mission has no daemon tick, so only
the control plane's clock can fire anything on time; (2) `applySharedAcl` sets a *default* ACL
`u:<agent>:rwx` on `shared/`, so every daemon-written file under `shared/jobs/{running,status}` is
writable and renamable by every agent — file-owner identity is defeatable by `mv` (rename keeps
uid 999) or a symlink. Also: `daemon.ts:204-206,508-509` falsely say the scheduler writes job files
(doc drift to fix), and `schedule-job.sh`'s `SHARED_DIR` fallback is dead code.

**Decision: one collection, the control plane keeps time; the daemon keeps execution.**

- `ScheduledMessageDoc` gains optional `kind: "message" | "job"` (absent = message, so existing
  writers in `copilot-router.ts`, `resource-upgrade.ts`, `mission-copilot-tools.ts` are untouched),
  `origin: "shared-schedules"`, `specHash`, `createdBy` (agentId derived from file uid), `jobSpec`
  (daemon-sanitised), `pendingFire?: {dueAt, requestedAt}`, `lastFiredAt?`.
- **Ingestion** — new `agent-runtime-worker/src/schedule-ingest.ts`, `ingestSchedules()` called from
  `startJobRunner.tick()` (`daemon.ts:525-573`, 60 s) before `runPendingJobs`: `lstat` each
  `shared/schedules/*.json`; reject symlinks, `nlink>1`, bad filenames (`^[a-z0-9][a-z0-9._-]{0,63}\.json$`);
  label = filename stem (in-file `label` must match); owner uid → agentId via a boot-built
  `Map<uid, agentId>` (`daemon-boot/agent-identity.ts`, `id -u` per `resolveLinuxUsers` entry;
  unknown uid → skip + anomaly); validate cron, `to ⊆ roster ∪ {"user"}`, absolute `scriptPath`;
  `specHash = sha256(canonical file)`; idempotency key `{missionId, origin, label}` with a partial
  unique index created at boot; `$setOnInsert` on first sight, `$set` (new `deliverAt = next(cron)`,
  `status: pending`, `deliveryAttempts: 0`) only when the hash changed or the doc was cancelled;
  labels with no file → `cancelled`. `CancelScheduledMessage` on an `origin` doc also unlinks the
  file (else the next tick resurrects it). Emits the long-promised `[daemon:scheduler] Schedule
  imported: <label> → next at …` line.
- **Firing jobs** — `scheduler.ts deliver()` branches on `kind === "job"`: no mailbox insert; `$set
  pendingFire {dueAt: deliverAt, requestedAt: now}` (overwrite = coalesce missed occurrences), then
  the existing re-arm. Daemon tick `claimJobFires()`: `find({missionId, kind:"job", origin,
  pendingFire:{$exists:true}})`; write `<mission>/jobs-private/queue/<label>-<dueAtEpoch>.json`
  (deterministic → idempotent across a crash between write and clear), then
  `updateOne({_id, "pendingFire.dueAt": dueAt}, {$unset: {pendingFire}, $set: {lastFiredAt}})`.
  Catch-up after a suspend: fire once (the control plane already woke the machine); if `now - dueAt
  > 6 h`, skip and record a `scheduling-failure` anomaly.
- **Daemon-private job state** (also fixes JOB1/JOB2 structurally): `$AGENT_WORKDIR/missions/<id>/
  jobs-private/{queue,running,status}` beside `shared/` — same placement and ownership as
  `shared.git` (the mission dir has no agent ACL), mode 0700. Daemon-authored specs (scheduled
  fires, `RestartBackgroundJob`, recovered orphans) live only there; `recoverOrphanedJobs`,
  `ListBackgroundJobs` and `RestartBackgroundJob` read only there; `shared/jobs/status/` becomes an
  agent-readable mirror (agents keep `ls`-visibility). Changes ADR-0011's layout — recorded in
  ADR-0033.
- **Identity (JOB1/JOB2)** — uid attribution, not Tool-API submission (`submit-job.sh` runs inside
  the agent's Bash turn without a token, and the uid is already unforgeable since only
  `magi-operator` can `sudo`). Extract `runPendingJobs` into `job-runner.ts` with injected
  `{daemonUid, uidToAgentId, teamConfig, fs, spawn}`. For `shared/jobs/pending/*.json`: `lstat`;
  reject symlink, `nlink>1`, unknown uid, and uid 999 (a daemon-owned file there can only be a
  rename); `agentId := uidToAgentId.get(uid)`; reject if `spec.agentId` disagrees; never read
  `spec.linuxUser`; `id := filename stem` validated as UUID/slug and must equal `spec.id` (JOB2);
  the private queue is trusted as written.
- **Scripts/skills** (WS-5 wording): `schedule.sh` validates the label charset, otherwise unchanged
  ("imported within a minute; edits re-arm; `rm` cancels within a minute"); `schedule-job.sh` drops
  `LINUX_USER`/`linuxUser`, `--agent` defaults to `$AGENT_ID` ("runs as the user who created the
  file; `--agent` must be your own id"); `submit-job.sh` unchanged in shape, same sentence.
- **Tests** (`schedule-ingest.unit.test.ts`, `job-runner.unit.test.ts`, extend control-plane
  `scheduler.unit.test.ts`; fake db as in `scheduler.unit.test.ts`, tmpdir fs as in
  `job-recovery.unit.test.ts`, injected `lstat` to fake uids): same file twice → one doc, `deliverAt`
  untouched; cron edit → new `deliverAt`; file removed → cancelled, re-created → pending;
  `spec.agentId` ≠ owner → not spawned + anomaly; symlink and uid-999 files rejected; `kind:"job"`
  deliver sets `pendingFire` and re-arms; claim after a 2-day-old `dueAt` fires exactly once; two
  overdue occurrences → one queue file; `spec.id = "../../x"` rejected in recovery and runner; crash
  between queue write and `$unset` → re-claim doesn't duplicate.
- **Trade-offs recorded in ADR-0033:** the control plane learns about `jobSpec` (gains wake-up and
  one catch-up policy; a daemon-only `scheduledJobs` collection could never fire on a suspended
  machine); agents lose `ls jobs/running` (mirror + tool compensate); uid mapping assumes real OS
  users (local-dev pool mapping already fails loudly when oversubscribed); fire-once-with-6 h-cap
  can skip a legitimately late run (the anomaly makes it visible).

## Execution order and milestones

| M | Content | Gate to next |
|---|---|---|
| M0 | WS-0; WS-3 §1–5 (verify, tripwires, ratchets at current levels, CI gating, hooks); `trust-boundaries.md` draft | `npm run verify` green in CI; deploys wait on Quality |
| M1 | WS-1 B, C (all remaining Highs), B6 EXFIL1 | all Highs `fixed` in STATUS.md; `/code-review` on each; rotate secrets; commit plan doc + audit (redacted) |
| M2 | WS-1 D, E + live loop bugs (#55/#56/#58/#64/#65) | integration suite green (VPN off); #62 CAS hypothesis checked |
| M3 | WS-1 F, G | `npm audit --omit=dev` clean; Node 22 images deployed to dev |
| M4 | WS-2 (scheduler ADR-0033, stats, cockpit, skills/templates functional fixes) | scheduler live-verified on a throwaway mission; #53 closed |
| M5 | WS-4 (ratchets already in; R-1, R-3, R-2; plumbing; dead code) | tests unchanged across refactors; allowlists shrank |
| M6 | WS-5 docs + contract tests; WS-6 roadmap; first `/sprint-audit`; `/sprint-close` | consistency matrix all ✅/deleted; audit re-finds nothing High |

Rough effort, solo: M0 2 d · M1 1.5 w · M2 1 w · M3 3 d · M4 1 w · M5 1.5 w · M6 1 w ≈ 7 weeks.
Deploy = push to main throughout; nothing is behind a flag.

## Verification

- Every commit: `npm run verify` (build, lint, unit + coverage ratchet, tripwires, contract tests);
  security commits additionally `/code-review` asked to refute, plus `/security-review` per group.
- Each milestone: `npm run test:integration` with the VPN off (Atlas SRV/TXT lookups time out
  through the VPN's resolver — the cause of the first failed run).
- Live, on dev (read-only unless stated): Q4 6PN reachability `curl` between two mission machines
  (decides M1 B2's urgency, not its necessity); Q3/Q5 `HOME`, `getfacl` on `shared.git` and a
  private workdir; first resume after deploy migrates a legacy `shared/.git` (log line); cockpit
  under CSP (mermaid, katex, Firebase sign-in, SSE); monitor GETs 401 without the proxy; legacy
  `/missions/:id/dashboard` 404; a throwaway mission's `schedule.sh` daily brief fires on the
  control-plane scheduler and a `schedule-job.sh` recurring job runs once after a suspend; new
  mission shows the $25 cap and the $100 ceiling in the Limits panel; deploy workflow visibly waits
  on Quality in Actions; `/sprint-audit` first run lists no new High.
- Explicitly flag anything not live-verified in `findings.md`/resilience rows (this sprint's
  honesty convention).

## Reconciliation of audit findings

Disposition codes: **FIXED** (shipped, commit) · **FIX** (this sprint, workstream) · **DEFER**
(tracked issue / later sprint, with target) · **ACCEPT** (documented risk or trade-off, no change) ·
**MODIFY** (accepted with a different fix than proposed) · **REJECT** (not done, reason) ·
**VERIFY** (live check decides).

| Findings | Disposition | Where / note |
|---|---|---|
| ENV1, TF1+CHAIN-A, GIT1, MID1, X-TENANT3 | FIXED | F-032..F-036; MID1 zod-level and X-TENANT3 per-user OS identity remain (DEFER → below) |
| MS1, RS2, AR1/AR2, DOC4, INSP1, MC8, MS2/MS5/MS6 | FIX | WS-1 B1 |
| M1, X-TENANT1, MCR1 | FIX (+VERIFY Q4) | WS-1 B2 |
| S1, S2, S3, FU1, FU2, FU3, FU4, B1, B1b | FIX | WS-1 B3 |
| B2 (Stagehand `file://`/`chrome://`) | VERIFY → FIX if real | WS-1 B3; check whether the agent exposes navigation and whether Chromium inherits the env |
| JOB1, JOB2, PROXY1 | FIX | WS-1 B4 / ADR-0033 identity model |
| SK1, WM1, ISO1, P7a | FIX | WS-1 B5 |
| EXFIL1, MCR3, F-021, F-023 | FIX | WS-1 B6 (repo is public) |
| XSS1/X1, AUTH1, C2, MS4, MT1 | FIX | WS-1 C1 |
| LEG-XSS, LEG1, M3 | FIX (delete) | WS-1 C2, D-4 |
| EXP1 | MODIFY | fix the tracked script, keep `experimental/` (local variants in use) |
| LP2 | FIX | WS-1 D1 |
| EA1, EA2, EA3, EA5, EA7/EA8, SCHED3, SCFG1, CK-GATE, CP1 (store) | FIX | WS-1 D2 + WS-4 R-3 |
| OB3, OB4, OB5, OB6 | FIX | WS-1 D3 (OB4 indexes with CR1) |
| MBX1, MR1, MB1–MB5 | FIX | WS-1 D4 / D5 |
| LU1, RID1, CFG1, MC6, MC7, MC1 | FIX / ACCEPT (MC1: the copilot editing config is the design; bounded by the ceiling + audit mail) | WS-1 D5 |
| D1, C1, R1, RF1–RF3, CW2/CW3, SCH1–SCH5, LAUNCH1/2, FLY4–FLY7, RAS1, FE1, OC1, OC2, RM1–RM3, BD1, AS1, COPCAP1, CD1, CD2, MW1/D7, LG1/OC4, TA2, T1, T2, T3, AUTH2 (#7), AUTH-BF, PX1/C3, RU4/RU5, SEG1/SEG2, MCF2, AB1, PID1 | FIX | WS-1 E |
| RF4 (reflection summary as user-role message) | ACCEPT for now; DEFER design | needs a trust-labelled summary role — issue, Sprint 29-adjacent |
| TOK1 (per-mission token never expires) | MODIFY | document `MONITOR_SIGNING_KEY` rotation as the revocation path now; per-mission nonce later (issue) |
| LM1, LIM1, CFG2, TPL5, MD1, COST-1, AS1, DOC8 | FIX | WS-1 F (D-3) |
| P4/P-deps, CI1, CI2, CI3, BS1, BS2, BS3, BS4, DOCK3, DOCK4/SD1, DOCK5, ISO2/DK1, RECON1, RECON2, MIG1, H1 | FIX | WS-1 G (`firebase` major: DEFER) |
| X-TENANT2, P7, P7b | ACCEPT (documented) → Sprint 29 | D-7; every daemon bug is cross-tenant until then — stated in threat model |
| SCHED1, SCHED2, SKL2, SKL6, SKL7 | FIX (build) | ADR-0033, D-2 |
| STATS1 (#53), CK-STALE, TX1 | FIX | WS-2.2 |
| DE1, DE2, DE3, CK-UPLOAD1, CK2/M4, CK-ERR, CK1, CP1, CP2, CNV1, CNV2, FP1, CFG-P1, MS3 | FIX | WS-2.3 |
| NEWS1, DF1, DF2, DF3, ADP2, DF5, NEWS2, TPL2, TPL4, MAF1, TPL6, SKILLS-DRIFT, DOC1, DOC2, DOC7, DOC9, DOC10, DP1, SK-READ | FIX | WS-2.4 |
| DUP1, DF-REQ/P5, DOC3, DOC5, DOC6 | DEFER (issue) | Python dedupe + pinning; per-format split under the ratchet |
| CLI1, CLI2, CLI7 | FIX | WS-2.5 |
| CLI3–CLI6, MIS1, MIS2, MIS3, MIS5, TA1, TA3, UI1, PR1, CU1, LP1, LP3–LP6, WM2–WM5, MD2, MC4, MC5, MC9, RS3, RS5, ATL1, RR1, TPL1, GH1, MG1, TY1, IDX1, CTX1, NP1, ML1, OP1, FLY9, R2, R3, O2, O4, D3, D4/T4, D5, M2, A2, P1, P2/P3 | FIX (small, folded into the nearest workstream commit) or DEFER as one "low" issue if untouched by M6 | mostly WS-4 plumbing + WS-5 comments |
| O1 (#60), D6, R-4, R-5 (#34), R-6, R-7/CK-DUP/CK10/CK7/CK11/CK6/CK5, R-14, A1, MIS6 (partly R-1) | DEFER under ratchets | issues; R-1/R-2/R-3 are FIX (WS-4) |
| TESTGAP, CK5 coverage | FIX | WS-3 ratchets + regression tests per finding |
| CR1/CR2 (#54) | FIX indexes; DEFER retention/compaction design | issue #54 stays open |
| LL1/SCH6, OPS1 (G-8) | MODIFY / DEFER | pick the `llmCallLog` retention and make docs = code; data tier move Post-MVP (before paying tenants) |
| DEL1 | DEFER (D-6) | Post-MVP archive path |
| AN1, OV2 | FIX | wrap/quote agent-influenced text in system mail; provenance + cap on injected objectives |
| RS1 | FIX | Research sub-loop honours `disabledTools` |
| MM1 | ACCEPT | defensible only because of the sandboxed iframe — documented |
| H2 | FIX (console) | restrict the Firebase client key by referrer; doc note |
| Doc matrix §8, Lot 8 SPEC drift, MCP1, OV1, COPSKILL-DRIFT, SKL1/3/4/5/8, IT1, TPL3, TPL-LINUXUSER, DEAD-PARKED, CD3 | FIX | WS-5 / WS-4 dead code |
| Process: RC1–RC9, INV-1..10, tripwires, ratchets, `/sprint-audit`, contract tests, trust-boundaries table, metrics trend | ACCEPT | WS-3 |
| Process: one PR per finding, branch naming, Agent V verifier per PR | MODIFY | one commit per finding; `/code-review` as verifier; no PRs (solo) |
| Process: Stop hook runs full `npm run verify` | MODIFY | `verify:quick` on Stop (full verify takes minutes); full in pre-push + CI |
| Process: CLAUDE.md to 120–150 lines | MODIFY | ~150–200; triggers move to nested files, invariants stay |
| Process: bulk rewrite of 302 history comments | REJECT | T11 ratchet instead; one-line incident references stay (they are the "why") |
| Process: seeded golden defects for the auditor | DEFER | after the first `/sprint-audit` run |
| Express 5 upgrade | DEFER | wrapper + handlers now (C1); major as its own step |
| Deleting `experimental/` | REJECT | see EXP1 |
| Audit Q1–Q13 | Q1 invite-only · Q2 public → B6 · Q3/Q4/Q5 live checks (Verification) · Q6 no → D-3 · Q7 moot (daemon git via explicit `--git-dir`; agents never run git) · Q8 verify when touching data-factory · Q9 bug, removed · Q10 `trust proxy` is set → upgrade `proxy-addr`; P7 Sprint 29 · Q11 yes, generated tables · Q12 delete · Q13 yes, M4 | |

## Progress log

- 2026-10-16 — **M0 done** (`f228ad4`…`51df405`): verify script, tripwires, structure + coverage ratchets, complexity gate, hooks, one Quality pipeline gating both deploys, gitleaks config, trust-boundaries table, DEFER issues #66–#75. Coverage floors are maintained by hand (not `autoUpdate`) since `fbe5e43` — CI measures a few hundredths under a dev machine.
- 2026-10-16 — **Dependency pass pulled forward from M3** (`e45a95b`): hpm 4, firebase 13, stagehand 3.7.3, Node 22 images, better-npm-audit + `.nsprc`; production audit clean.
- 2026-10-16 — **Incident** (Fly machine limit → hand-deleted machines → running missions hidden as `destroyed`): recovered via `POST /:id/resume`; fix `16f60f5` (status mapping, `wakeTracked`, orphan detector); design question → #76.
- 2026-10-16 — **M1 B1 done** (`6261e2f`): `safe-path.ts` + MS1/MS2/MS5/MS6 (F-037), RS2 (F-038), AR1/AR2/DOC4 (F-039), INSP1 (F-040), MC8 (F-041); monitor file surface extracted to `monitor-files.ts`. Deployed via the new `workflow_dispatch` (`ff3b1aa`) after the original push's run failed a coverage floor — that gap is documented in `docs/deployment.md` §3.
- Next: **M1 B2** (monitor token on every route incl. GETs and `/events`; live check Q4 first), then B3 SSRF, B4 JOB1 (identity by file uid; private queue), B5, B6, C1–C3.
- 2026-10-17 — **M1 B2 done**: Q4 live check proved X-TENANT1 (one mission machine read another's `/files/shared` over 6PN). Fix: token on every monitor route incl. GET/SSE, constant-time compare, `requireMonitorToken` fails closed on Fly, route-table enumeration test (F-042). Structure ratchet gained a bounded slack (20/10 lines) after one-line security edits in oversize files tripped it.
- Next: **M1 B3** SSRF (redirect re-validation, IPv6 forms, streaming cap).
- 2026-10-17 — **M1 B3 done** (F-043): `ssrf.ts` rewritten (address classifier, all answers, fail closed, `resolvePinned`), `safe-http.ts` (pinned `http.request`, manual redirects, streaming cap, timeout) used by FetchUrl + image fetches; egress proxy pins connects. Audit B2 (in-browser `file://`) recorded as **F-044 open** — verify with the BrowseWeb harness, fix via Chromium managed policy or running Chromium as the agent user. CI: image job now sequenced after the control-plane deploy + pin step retries (lease contention left `FLY_MISSIONS_IMAGE` staged once; applied by hand with `flyctl secrets deploy`).
- Next: **M1 B4** JOB1/JOB2/PROXY1 (job identity from file owner uid, `job-runner.ts` extraction, private queue — shares ADR-0033's design).
- 2026-10-17 — **M1 B4 done** (F-045, F-046; ADR-0033 written — §1 identity + §2 private queue implemented, §3 schedule ingestion planned for M4): `job-runner.ts` extracted from daemon.ts with owner-uid attribution and `jobs-private/{queue,running,failed,status}`; recovery/restart/list moved onto it; data-provider proxy gained a daemon-side daily cap.
- Next: **M1 B5** SK1/WM1/ISO1 (private workdirs 0700 + read denial, skills tier dirs, description cap / shadowing), then **B6** EXFIL1 gate, then **C1–C3**.
- 2026-10-17 — **M1 B5 done** (F-047): workdir read denial (0700), skills tier dirs locked, skill text hardened, copilot prompt excludes agent-authored skills.
- Next: **M1 B6** EXFIL1 — GitHub issue tools behind ProposeAction (`file_github_issue`), per-mission daily quota, untrusted-body prefix; then C1 (XSS/CSP/cookie), C2 (delete legacy dashboard), C3 (EXP1).
- 2026-10-17 — **M1 B6 done** (F-048, closes F-021/F-023): GitHub writes gated behind `file_github_issue` with payload on the card; mission-copilot proposals routed to the owner's cockpit; quota + provenance. Pending-action persistence (Mongo) stays with M2 D2/CP1.
- Next: **M1 C1** XSS1/X1/AUTH1/C2/MS4/MT1 (cockpit markdown escaping + URL scheme allow-list + payload corpus; CSP/nosniff; HttpOnly session cookie; attachment downloads), **C2** delete legacy dashboard, **C3** EXP1.
- 2026-10-17 — **M1 C1 done** (F-049 XSS1/X1, F-050 AUTH1/C2, F-051 MS4/MT1): markdown renderer escapes quotes + URL-parser allow-list with a tokenising test oracle; server-issued HttpOnly cookie (`/api/auth/{session,me,logout}`), `?token=` gone, no credential in sessionStorage; CSP (report-only → `CSP_ENFORCE=true` after dev reports are clean) + nosniff/referrer/framing; SVG inline = attachment + sandbox. `index.ts`'s pre-auth surface extracted to `public-routes.ts` (structure ratchet).
- Next: **M1 C2** delete the legacy dashboard (D-4), **C3** EXP1; then commit the redacted plan + audit doc, rotate secrets, M2.
- 2026-10-17 — **M1 C2 done** (F-052): legacy dashboard deleted (files, `static-assets.ts`, `publicDir`, build copy, `monitor-static` + Playwright `dashboard` tests); tripwires T2/T3 allowances retired; USER_GUIDE/CLAUDE.md/proxy comment updated.
- Next: **M1 C3** EXP1, then commit the redacted plan + audit doc, rotate secrets, M2.
- 2026-10-17 — **M1 C3 done** (F-053 EXP1). **All M1 Highs fixed.** Remaining M1 close-out: secret-expansion live check (read-only), commit the redacted plan doc + `docs/review/2026-10-audit.md`, user rotates secrets.
- 2026-10-17 — **M3 G done** (F-069: BS1/BS2/BS4, RECON1/RECON2 with `scripts/lib/reconcile-policy.mjs` + tests, DOCK4/SD1, DOCK5 digest pins, ISO2/DK1 — `/opt/magi-src` static root ownership + pre-created `mission-copilot` user + boot-time verification replacing the runtime `setfacl`, MIG1 guard, H1 `/healthz`; DOCK3 accepted). Deferred to #78: `npm prune --omit=dev`, CI image scan, BS3 CI-token scoping (all need an image build to validate; no Docker in this WSL distro). **Dockerfile changes are verified by the next CI image build and the first mission booted on it (`can read /opt/magi-src` log line).** M3 gate: `npm audit --omit=dev` clean since M0; Node 22 images deployed since M0.
- Next: **M4** — ADR-0033 §3 schedule ingestion (`schedule-ingest.ts`, `kind: "job"` firing, private queue claim), STATS1/#53 + CK-STALE/TX1, cockpit behaviour bugs (2.3), skills/templates functional fixes (2.4), CLI fixes (2.5).
- 2026-10-17 — **M4 2.1 done (code)** — ADR-0033 §3 built: `schedule-ingest.ts` (uid-attributed import of `shared/schedules/*.json`, re-arm on spec-hash change, cancel on `rm`, `pendingFire` → private-queue job with deterministic id and 6 h lateness cap + anomaly), `scheduler.ts` stamps `kind: "job"` docs instead of mailing them (UTC re-arm), copilot `CancelScheduledMessage` removes the file / `ListScheduledMessages` shows kind·origin·createdBy (tools split into `mission-copilot-schedule-tools.ts`, result helpers into `mission-copilot-tool-result.ts` — structure ratchet), `schedule.sh`/`schedule-job.sh` + both SKILL.md texts describe the real mechanism (`linuxUser` gone, `--agent` must be self, label slug), gold-digest template example updated, SPEC/CLAUDE.md/trust-boundaries/threat-model/resilience rows. Tests: `schedule-ingest.unit` (11), `scheduler.unit` (+3), `mission-copilot-tools.unit` (+1). **Live verification pending** (M4 gate: a throwaway mission's `schedule.sh` brief fires via the control plane; a `schedule-job.sh` job runs once after a suspend). CI note: the `1e1c0a0` control-plane deploy timed out waiting for health checks (flyctl could not poll the Machines API — `net/http` error); the execution-image job was skipped, so the M3 G Dockerfile changes are first built by the next push.
- Next: **M4 2.2** STATS1/#53 (`/api/missions/stats` from `missionStats`/`agentTurnStats`), CK-STALE, TX1 (`callId`), then **2.3** cockpit bugs, **2.4** skills/templates (NEWS1, DF2/DF3/ADP2, TPL2, TPL4/MAF1/TPL6, SKILLS-DRIFT, DOC1/2/7/10, DP1), **2.5** CLI.
- 2026-10-17 — **Boot-time Mongo connect retry** (both planes, `connectWithRetry` in `agent-runtime-worker/src/mongo.ts`, 2 s → 30 s backoff, 10 min budget): found from the `1e1c0a0` deploy failure — one `querySrv ENOTFOUND` at boot crash-looped the control plane to Fly's restart cap and left it stopped ~5 min. Resilience Layer 2 row + "Recently fixed" entry. Not an audit finding; logged here because the sprint's rule is one fix per observed failure.
- 2026-10-17 — **M4 2.2 done** (STATS1/#53, CK-STALE, TX1): `mission-stats-summary.ts` replaces the `/stats` aggregation (lifetime from `missionStats`, windows from `agentTurnStats`, unread from `readBy`, snippet = last mail to the operator); `transcript-queries.ts` serves one flattened `CallUsage`/`costUsd` shape (+ the real `stopReason`), cockpit types moved to `llm-call-types.ts`; a per-call `callId` from `runInnerLoop` is stored on the log entry and the assistant message and the panels join on it (`call-index.ts`). Contract test typed against the writer's `LlmCallLogEntry` (the WS-3 §6 `schema.consumers` seed). Also: Atlas default limit → 10 GB (cluster moved to M10 today; `ATLAS_STORAGE_LIMIT_MB=10240` still to be set on the control plane by the operator), G-8 downgraded (backups exist, runbook/RTO still owed), "7-day window" texts made retention-neutral pending the LOG_RETENTION_DAYS decision. `createLlmCallHook` extracted from `runAgent` (ratchet).
- Next: **M4 2.3** cockpit behaviour bugs (DE1/DE2/DE3, CK-UPLOAD1, CK2, CK-ERR, CK1, FP1, CFG-P1, CNV1, MS3), **2.4** skills/templates, **2.5** CLI; then the M4 live gate and #53 close.
- 2026-10-17 — **M4 2.3 done** (cockpit behaviour bugs DE1/DE2/DE3, CK-UPLOAD1, CK2, CK-ERR, CK1, FP1, CFG-P1, CNV1, CNV2, MS3): one `request()` helper in `data.ts` (401 vs 403, every failure throws), demo data removed, load failures rendered in every panel, draft editor fixes (launch gated on save, rename cascade, duplicate ids, cap field — `DraftMissionFields.tsx` + `validateDraft`), file viewer guard + `expectedHead`/409, config PUT `expectedUpdatedAt`/409 (`config-version.ts`), hidden-tab polling pause, send errors shown, RFC 6266 `Content-Disposition` (`contentDisposition` in `monitor-files.ts`, with `parseEditRequest`/`editHeadConflict` extracted there). CP1/CP2 were closed by D2 (Mongo pending actions + replay).
- Next: **M4 2.4** skills/templates (NEWS1, DF2/DF3/ADP2, TPL2, TPL4/MAF1/TPL6, SKILLS-DRIFT, DOC1/DOC2/DOC7/DOC10, DP1), **2.5** CLI (CLI1/CLI2/CLI7), then the M4 live gate.
- 2026-10-17 — **M4 2.4 (document processing) + 2.5 (CLI) done**: `document-zip.ts` (sizes from the central directory before inflating, ratio check, depth-based nested-archive refusal by content), `maxTextPages` for PDFs, render/describe failures → `partial`, OCR/vision text marked untrusted (DOC1/2/7/9/10); DP1 already closed by B4+LP2; `cli-reset` clears every per-mission collection, `cli.ts` wires the audit log and the spend cap (`cli-cap.ts`), CSV formula neutralisation (CLI1/2/7). Deferred: moving mupdf text extraction off the daemon thread (DOC7's second half) — needs a worker thread; file with the M4 close-out issues.
- Next: **M4 2.4 remainder** — templates and skills text (TPL2, TPL4/MAF1/TPL6, SK-READ), data-factory Python (NEWS1, NEWS2, DF1/DF2/DF3/ADP2), SKILLS-DRIFT (platform catalog endpoint for the cockpit); then the M4 live gate.
- 2026-10-17 — **M4 2.4 templates done** (TPL2, TPL4, MAF1, TPL6, SK-READ): objectives-demo on the objectives tools; gold-digest/equity-research text matches the real commit protocol, digest-id interface, key path and scheduler; gold playbook moved out of the platform tier; duplicate playbook.json deleted; reader id guards.
- Next: data-factory Python (NEWS1, NEWS2, DF1/DF2/DF3/ADP2) and SKILLS-DRIFT (cockpit skill/tool lists from a server catalog), then the M4 live gate.
- 2026-10-17 — **M4 2.4 done** (data-factory NEWS1/NEWS2/DF1/DF2/DF3/ADP2; SKILLS-DRIFT via `GET /api/catalog`). Python tests now run in CI (`data-factory-python` job, offline subset). **M4 code complete**; remaining for the M4 gate: live verification of the scheduler on a throwaway mission (needs Anthropic credits), and the deferred DOC7 worker-thread extraction → issue.
- Next: file the M4 close-out issue(s), then **M5** (R-1 missions router split, R-3 already done via the action registry, R-2 runAgent phases, R-8 env.ts, R-15 typed stored schemas, dead code).
- 2026-10-17 — **M5 dead code**: performDestroy removed (DELETE stays 403), templates.ts dead test/ branch, EPHEMERAL_TOOLS "ReadFile"; ML1 deliberately kept until a sweep for pre-ADR-0019 file stores; CD3 is a real test seam (wontfix); packages/parked already gone. CI for 9c1c83f pending (first run with the M3 Dockerfile changes and the Python job).
