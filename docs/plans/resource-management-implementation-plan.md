# Implementation plan — ADR-0031 (temporary machine upgrades) and ADR-0032 (resource oversight)

Working title **Sprint 28g** (number to be assigned; the ADRs say "right after 28f"). Implements
[ADR-0031](../adr/0031-temporary-resource-upgrades-vm-cost.md) and
[ADR-0032](../adr/0032-proactive-resource-oversight.md). Read those first — this plan does not repeat
their design, only how to build, test, secure, document and roll it out.

## Progress

| Step | Status |
|---|---|
| 0.1 Baseline | ✅ 2026-09-20: build, lint, 47 unit files / 487 tests, `daemon-job.integration.test.ts` all green |
| 0.2 Roadmap, ADR status, issues | ✅ 2026-09-20: roadmap row and CLAUDE.md entry, ADRs Accepted (sprint 28g), issues #53 and #54 filed |
| 1.1 Copilot waker | ✅ 2026-09-20: 27 unit + 4 integration tests (real Mongo Change Stream); LIVE on dev: a relay posted to a throwaway `copilot-{user}` mailbox with no daemon was read by a newly started daemon in 2 s and answered (test data cleaned up) |
| 1.2–1.4 Thresholds, alert state, anomaly categories, stats index | ✅ 2026-09-20: `resource-thresholds.ts`, `resource-alert-state.ts` (26 tests incl. hysteresis, fail-open), 8 new `AnomalyCategory` values (16 tests), `agentTurnStats` `{missionId, startedAt}` index (1 test); the `explain` check runs in step 5.4 when the first windowed query exists |
| 2.1 Shape rules, price table, menu | ✅ 2026-09-20: `machine-shapes.ts`, 59 tests including an exhaustive sweep of 10,000+ shapes against an independent oracle |
| 2.2 Segment tracking + tracked lifecycle | ✅ 2026-09-20: `machine-segments.ts` (pure summaries, persistence, `reconcileSegments`), `machine-lifecycle.ts`; all 11 call sites in `missions.ts`, `copilot-router.ts`, `scheduler.ts` moved onto it, with an import guard test (56 new tests). `reconcileSegments` is scheduled in step 5.4; the revert-on-suspend of an upgraded mission arrives with 2.3. LIVE on dev with throwaway mission `zz-lifecycle-smoke-f5nlew` (left suspended, reused for step 2.7): create opened a segment, suspend closed it, resume (delete + provision, new machine id) opened a new one, final suspend closed it; destroy is disabled on dev (403) |
| 2.3 Upgrade service | ✅ 2026-09-20: `resource-upgrade.ts` (request / same-shape renewal / revert / sweeper / suspend-with-revert), `resizeTracked`, scheduler and status-refresh skip a held claim, both suspend paths use `suspendMissionMachine`; 45 unit tests over an in-memory Mongo fake, with the cap boundary, cooldown and renewal compare-and-set mutation-checked. Not yet reachable: the route and the scheduler tick that runs the sweeper are step 2.4 |
| 2.4 Route + sweeper tick | ✅ 2026-09-20: `POST /api/mission-copilot/resources/upgrade` and `/revert` behind the existing token check, `createUpgradeSweeper` on the scheduler's 1-min tick and at startup; 12 new tests (real HTTP server around the router: 401 without/with another mission's token, fail-closed without a signing key, generic 500). Threat model TB-22 + STRIDE + DFD edge and finding F-031 added. LIVE pending the tool (2.5) |
| 2.5 Tier B tool | ✅ 2026-09-20: `resource-upgrade-tool.ts` (`RequestResourceUpgrade`, `EndResourceUpgrade`) wired into `createMissionCopilotTools`; 22 tests (mission id cannot be overridden by arguments, every rejection relayed, 404 from an old control plane, network failure, no control-plane URL); SPEC Tier B section updated. LIVE on dev 2026-09-22 (`zz-lifecycle-smoke-f5nlew`, real HTTP calls to the deployed routes exactly as the tool would make them): real Fly resize to shared/2/4096, notifications posted, cooldown 429 immediately after, same-shape renewal with no restart, sweeper reverted the expired upgrade to a fresh default machine within ~1 min, seeded-24h cap test rejected with 403 and exactly one `upgrade-cap-reached` anomaly. Mission left suspended, seed data cleaned up |
| 2.6 `GetMissionStatus` extension | ✅ 2026-09-22: adds current tier (default or upgraded, with expiry), time on that tier from the open segment (`getOpenSegment`, new in `machine-segments.ts`), and cumulative upgraded runtime used/cap since the last operator reset; 4 new integration tests against real Mongo (no machine at all, custom default sizing, upgraded tier, runtime computed across a reset boundary) |
| 2.7 LIVE — full end-to-end scenario | ✅ 2026-09-22, real LLM agents throughout (no raw HTTP), on `zz-lifecycle-smoke-f5nlew` (general-assistant template, deepseek-chat): (1) sent the `assistant` agent a Bash command allocating 1400 MB on the default 1024 MB machine — real `MemoryError`, issue #31's motivating failure, no crash. (2) Messaged `mission-copilot` describing the failure; its own LLM turn called the real `RequestResourceUpgrade` tool (shared/2/4096, 2 min, `requestedByAgentId: assistant`) — verified against live Fly, not just Mongo: `cpu_kind/cpus/memory_mb` matched exactly. (3) **Emergent, unprompted**: the "Machine upgraded" notification (addressed to user + mission-copilot + assistant per Decision 4) woke the assistant, which on its own re-ran the same failing command and reported success — before any further instruction was sent. An explicit "retry" message afterwards got a second, consistent success reply. (4) The sweeper reverted automatically within its 1-min tick; the "Machine returned to the default" notice again woke the assistant, which sent an unprompted wrap-up message. (5) ~11 min after the clean revert, the mission's own machine stopped with a clean signal-less exit — traced to a genuine MongoDB Atlas connectivity incident (corroborated by the same outage affecting this session's own tooling for over an hour) hitting the daemon's `waitForMail` Change Stream, which is *documented pre-existing behavior* (`docs/operational-resilience.md`'s "Extended Atlas outage" row: loop exits, daemon shuts down cleanly, `on-failure` restart policy correctly does not restart a clean exit) — unrelated to and unaffected by the ADR-0031 code, which had already completed correctly 11 minutes earlier. Not re-run: the 80%/100% cumulative-cap seeded test, already covered live in step 2.5 on this same mission. Mission resumed then cleanly suspended to close out |

## 1. How the work is run

- **One step = one commit** on `main` (solo-dev workflow; push = deploy to dev). Each commit carries
  its own tests and its own doc updates (CLAUDE.md "Documentation" rule) and passes
  `npm run build && npm run lint && npm test` before it is made.
- **Every step is independently deployable and revertable.** Steps are ordered so nothing depends on
  a later step to be safe; where two planes must change, the order is stated (section 9).
- **Extend, don't grow oversized files.** `mission-copilot-tools.ts` (1263 lines) and `missions.ts`
  (1720) are already over the 500-line trigger, so new code goes in new files with at most a few lines
  of wiring in the big ones; `docs/code-structure.md` records this.
- **Verification per step:** typecheck (`npx tsc -p packages/<pkg>/tsconfig.json --noEmit`), lint,
  full unit suite, the step's own new tests; integration tests where the step says so; and a live
  smoke check on the dev deployment for anything with external effect (steps marked LIVE), following
  the CR-01/CR-02 practice of exercising the real thing on a throwaway mission.
- **Nothing here needs an LLM in tests.** Per CLAUDE.md we do not test prompt wording or skill content;
  skills and prompt text are reviewed by you.

### Decisions this plan adds (please veto)

1. ADR-0031 gained Decision 8 (state on the mission document, one resize at a time, 5-min cooldown
   for shape changes, an expiry sweeper in the 1-min tick, suspend/destroy ends an upgrade, a failed
   resize leaves the mission in `error`). These were gaps, not preferences; they are needed to
   implement safely.
2. No feature flags: rollback is a revert + redeploy.
3. Two follow-up issues (not in scope), filed 2026-09-20: [#53](https://github.com/arnadu/magi_v3/issues/53)
   (`GET /api/missions/stats` spend fields read nonexistent fields) and
   [#54](https://github.com/arnadu/magi_v3/issues/54) (`conversationMessages` retention).

## 2. Work packages and steps

Sizes: S ≈ under half a day, M ≈ about a day, L ≈ multi-day. Files are new unless marked *(edit)*.

### Phase 0 — Prep (S)

| # | Step | Notes |
|---|---|---|
| 0.1 | Baseline: `npm run build`, `lint`, `test`, and the daemon boot integration test (`daemon-job.integration.test.ts`) all green on a clean tree | Record the numbers so later failures are attributable |
| 0.2 | Roadmap row + sprint number; ADR-0031/0032 status Proposed → Accepted; file the two follow-up issues (with your OK) | `MAGI_V3_ROADMAP.md`, CLAUDE.md sprint list |

### Phase 1 — Shared foundations (M)

| # | Step | Files | Tests |
|---|---|---|---|
| 1.1 | **Copilot waker** (ADR-0032 D1). Extract `ensureCopilotRunning` + `runningDaemons` into `copilot-runtime.ts`; `copilot-router.ts` *(edit)* imports it; `startCopilotWaker(db, ensure)` (Change Stream on `mailbox` for `missionId ^copilot-`, `to` includes `copilot`, plus startup and 5-min catch-up scan for unread mail with no running daemon); start it in `index.ts` *(edit)* | `control-plane/src/copilot-runtime.ts`, `copilot-waker.ts` | Unit: fake change stream emitter — wakes once per user, ignores non-copilot mailboxes and `from: "user"` inserts, catch-up scan finds stranded mail, stream error → scan still recovers. Integration: insert a relay into a real `copilot-{uid}` mailbox with no daemon → `startCopilotDaemon` invoked. **LIVE:** post a hard anomaly on dev, confirm the daemon starts and reads it (this fixes today's gap on its own) |
| 1.2 | **Thresholds and alert state**. `resource-thresholds.ts` (all constants from ADR-0032 Decisions 3-4 and ADR-0031: 24 h cap, 4 CPU / 16 GB max, 60 min window, 5 min cooldown); `resource-alert-state.ts` (`evaluateAlert(store, key, ratio, thresholds, now)` with hysteresis, fail-open, backed by `resourceAlertState`) | `agent-runtime-worker/src/` | Unit: level rises / same level within 24 h / after 24 h / recovery 5 points below re-arms; fake Mongo |
| 1.3 | **New anomaly categories**: eight values in `AnomalyCategory` *(edit `anomaly.ts`; `atlas-storage-high` is platform-level and does not use the recorder)*; soft/hard semantics unchanged | `anomaly.ts` | Extend `anomaly.unit.test.ts`: soft is persisted and mission-copilot-notified but not relayed; hard is relayed |
| 1.4 | `agentTurnStats` index `{missionId: 1, startedAt: 1}` *(edit `agent-stats.ts`)* | | Index-creation test in the existing style; verify on dev with an `explain` |

### Phase 2 — ADR-0031 core: the upgrade mechanism (L)

| # | Step | Files | Tests |
|---|---|---|---|
| 2.1 | **Shape rules, price table, menu** — pure module: `validateShape({cpuKind, cpus, memoryMb, durationMinutes})` (Fly validity + max size + duration required, 1-60), `estimateCostPerHour`, `buildMenu()` | `control-plane/src/machine-shapes.ts` | Table-driven unit tests: every boundary (shared 256 MB × cpus … 2 GB × cpus; performance 2 GB × cpus … 8 GB × cpus; 256 MB steps; cpus sets), max-size rejects, duration missing/0/61/non-integer/NaN, error text lists valid options, **every menu row is itself valid**, cost monotonic in RAM and CPUs |
| 2.2 | **Segment tracking**. `machine-segments.ts` (collection `machineSegments`: open/close, `upgradedMsSince`, runtime-by-horizon and by-config aggregation, clipping at the reset time, in-progress counts to planned end). `fly-machines.ts` *(edit)*: `ProvisionOptions.cpuKind`. New `machine-lifecycle.ts` wrapping provision/stop/resume/destroy so every site opens/closes segments, and all call sites *(edit)* moved onto it: `missions.ts` (create, launch, suspend, resume, destroy), `copilot-router.ts` (suspend/resume actions), `scheduler.ts` (auto-resume). A suspend of an upgraded mission first reverts it (ADR-0031 D8), so resume never brings back an upgraded machine | `machine-segments.ts`, `machine-lifecycle.ts` | Unit: segments open/close exactly once per lifecycle, suspend closes an upgrade segment and clears `upgrade`, resume opens a default segment, reconstruct-after-crash (open segment with no machine); aggregation with reset straddle. A guard unit test greps that raw `provisionMission`/`suspendMission`/`resumeMission`/destroy are imported only by `machine-lifecycle.ts` |
| 2.3 | **Upgrade service** `resource-upgrade.ts`: `requestUpgrade`, same-shape renewal (extends expiry, no restart), `revert`, `sweepExpired`; atomic claim (`resizingSince`), cooldown, cap check (`used + duration ≤ 24 h`), roster check on `requestedByAgentId`, reminder `scheduled_messages` create/replace/cancel (`to: ["mission-copilot", requesterId]`), audit post (`from: mission-copilot`, `to: user`, reason capped at 500 chars and control characters stripped), anomalies (`upgrade-cap-reached`, `resize-failure`) via a control-plane `AnomalyRecorder`; failure handling per ADR-0031 D8 | `control-plane/src/resource-upgrade.ts` | Unit with injected Fly client and fake Mongo — see section 3.2 |
| 2.4 | **Route and sweeper**: `POST /api/mission-copilot/resources/upgrade` (and `/renew`, `/revert`) in `mission-copilot-router.ts` *(edit, behind the existing `verifyMissionToken`)*; `revertExpiredUpgrades` added to the 1-min tick and to startup in `scheduler.ts` *(edit)* | | Route tests in `mission-copilot-router.unit.test.ts` style (faked req/res): 401 without token, token for mission A cannot touch B, 400 on invalid shape/duration with valid options listed, 409 on concurrent claim, 429-style cooldown message. Sweeper unit tests: expiry reverts, startup catch-up, revert failure → `error` status |
| 2.5 | **Tier B tool** `RequestResourceUpgrade` (+ renew/revert) in `resource-upgrade-tool.ts`, wired with a few lines in `mission-copilot-tools.ts` *(edit)*; the tool calls `controlPlaneFetch` and formats the error (with valid options) back to the model | `agent-runtime-worker/src/resource-upgrade-tool.ts` | Extend `mission-copilot-tools.unit.test.ts`: present for the copilot only and absent from every other agent's tool list; the existing "no schema declares a `missionId`" test passes for it; request body shape; error surfaced verbatim; 404 (old control plane) → clear message |
| 2.6 | **`GetMissionStatus` extension**: machine config, time on it, upgraded time / cap, last disk sample and its age (sample fields appear once step 5.1 lands) *(edit `copilot-tools.ts`)* | | Extend `copilot-tools.integration.test.ts` |
| 2.7 | **LIVE — the motivating scenario** on a throwaway dev mission at the default 1 GB: run a job that allocates 3 GB → the machine or job is OOM-killed (issue #31's symptom); request 4 GB / shared via the copilot → the job succeeds; check `flyctl machine status` shows the new guest config, the volume data is intact, the mission is running, a segment is recorded, the reminder exists; use a 1-minute window to watch the automatic revert; insert historical segments to reach 80% and 100% of the cap and observe rejection | | Manual, recorded in the PR/commit message |

### Phase 3 — Operator surfaces for ADR-0031 (M)

| # | Step | Files | Tests |
|---|---|---|---|
| 3.1 | **Reset route and data**: `PATCH /:id/limits/upgrade-reset` (sets `upgradedRuntimeResetAt`, posts a `postLimitsAudit`); `GET /:id/limits` *(edit `missions.ts`)* gains `upgrades: {usedHours, capHours, resetAt, active}`; `GET /:id/machine-runtime` (segments by horizon and config); registered via one line from a new `mission-resource-routes.ts` | `control-plane/src/mission-resource-routes.ts` | Integration in the `limits.integration.test.ts` style (real Mongo): another user's mission → 404 for all three routes; reset changes `used` to 0 and leaves history; audit message posted; the writer is separate from every execution-plane write path (mirrors the F-025 test) |
| 3.2 | **Limits panel section** "Upgraded compute time" *(new `UpgradeLimitsSection.tsx`; one import in `LimitsPanel.tsx`; fetchers and types in `data.ts`)* | `packages/cockpit/src/` | Pure formatting helpers unit-tested (vitest); **browser check** per CLAUDE.md: bar colours, active upgrade, Reset with confirmation, error states, phone width |
| 3.3 | **Runtime tab**: new `RuntimePanel.tsx` (`MainTab` gains `"runtime"` in `App.tsx`), per-mission runtime by horizon and config, the "~$X estimated" annotation from the price table | | Helper tests + browser check |

### Phase 4 — Guidance for agents (S–M)

| # | Step | Notes |
|---|---|---|
| 4.1 | `packages/skills/request-resources/SKILL.md` (worker and mission-copilot sections, the shape menu generated from `machine-shapes.ts` at build or documented as regenerated), one-line pointer in `run-background/SKILL.md`, confirm the mission-copilot does not list it in `disabledSkills` (`mission-copilot.ts:344-360`), add a fallback line for missions with `MISSION_COPILOT_ENABLED=false` | Unit: skill discovery finds it with valid frontmatter (`skills.unit.test.ts` style); a test that the menu in the skill matches `buildMenu()`. Content reviewed by you |
| 4.2 | `MAGI_V3_SPEC.md` §6 tool table gets `RequestResourceUpgrade` (Tier B); skills list updated | Same commit as 2.5 for the tool row |

### Phase 5 — ADR-0032 instrumentation and alerts (L)

| # | Step | Files | Tests |
|---|---|---|---|
| 5.1 | **Disk sampler**: `resource-sampler.ts` (injected `statfs` and `du` runners, hysteresis via `resource-alert-state`, `disk-usage-high` soft/hard, top-5 directories via `execFile("du", ["-x","-k","--max-depth=3","/missions"])` with a 20 s timeout and no shell); called from the 60 s job-runner tick *(edit `daemon.ts`; `runningJobs` getter)*; upsert `missionResources`; skipped alerts when `FLY_APP_NAME` unset | `agent-runtime-worker/src/resource-sampler.ts` | Unit: thresholds and hysteresis, du output parsing fixtures incl. permission-error lines, timeout → alert still sent without the breakdown, a throwing sampler never breaks the tick. Integration: `daemon-job.integration.test.ts` still green. **LIVE:** `fallocate` a throwaway mission to 82% then 91%, then free it |
| 5.2 | **Atlas usage**: `atlas-usage.ts` (`listDatabases` → sum of `dataSize + indexSize` over non-system DBs, fallback to the app DB, `$collStats` breakdown for the app DB), writes `platformResources`; `atlas-storage-high` to each user in `PLATFORM_ADMIN_USER_IDS` (startup warning when empty) | `control-plane/src/atlas-usage.ts` | Unit with fake `db.admin()`/`dbStats`: sum excludes admin/local/config, denial falls back, percentage against `ATLAS_STORAGE_LIMIT_MB`, only admin users receive it. **LIVE:** compare the figure to the Atlas UI |
| 5.3 | **OOM detection**: `fly-events.ts` (`classifyExit(event)`; `listMachineEvents()` one list call; dedupe on `exited_at`) → `oom-suspected` | | Unit fixtures taken from the real dev events captured 2026-09-20 (requested stop; `exit_code: 1` restarting) plus synthetic 137 / signal 9 / `oom_killed`; a requested stop is never OOM; the same exit is not reported twice. **LIVE:** part of 2.7 |
| 5.4 | **Resource monitor tick** `resource-monitor.ts` (`startResourceMonitor(db)`, 5-min cron, started in `index.ts`): `spend-cap-near` (from `missionStats`), hourly `spend-spike` (from `agentTurnStats`), `upgrade-cap-near`, `upgrade-idle` (uses the `runningJobs` sample), 5.2 and 5.3 checks | `control-plane/src/resource-monitor.ts`, `resource-alerts.ts` | Unit per emitter with fake collections; each obeys `shouldAlert`; recorded per mission with the mission's owner as relay target; user A's alerts never reach user B's copilot mailbox (F-028 regression) |

### Phase 6 — Report and copilot behaviour (M)

| # | Step | Files | Tests |
|---|---|---|---|
| 6.1 | **Daily report**: `resource-report.ts` (`buildDailyReport`, `computeFlags`, `renderDailyReport`), `resourceSnapshots` with a unique `(userId, date)` index, scheduling at `RESOURCE_REPORT_HOUR_UTC` with startup catch-up, mailbox post from `system` | `control-plane/src/resource-report.ts` | Unit: golden-text test of the rendered format (structure only), flag table-driven tests (each threshold on both sides), growth/full-in projection from yesterday's snapshot, suspended and never-sampled missions, stale-sample flag, Atlas block only for admins, **multi-user isolation** (A's report contains none of B's missions), idempotency on a second run and after restart, catch-up when the hour was missed. Integration (real Mongo): seeded collections → report → mailbox document |
| 6.2 | **Copilot behaviour**: `config/teams/copilot.yaml` prompt section and mental-map table; four new team skills and edits to `cost-management`, `mission-recovery`, `incident-triage` (platform skill shared with the mission-copilot) | `config/teams/copilot/skills/{daily-resource-report,disk-pressure,atlas-storage,vm-upgrade-oversight}/SKILL.md` | Only structural checks (frontmatter valid, discovered by `provisionCopilotSkills`); wording is your review |
| 6.3 | **LIVE:** set `RESOURCE_REPORT_HOUR_UTC` to the current hour on dev; confirm the report arrives, the copilot posts a digest (or the one-line all-clear), a second trigger is a no-op, and a deliberately seeded flag appears | | Manual |

### Phase 7 — Close-out (M)

| # | Step |
|---|---|
| 7.1 | Documentation, threat model, findings and resilience updates from sections 4-6 (mostly written incrementally in each step; this step is the completeness pass) |
| 7.2 | Run `/security-review`, `/operational-resilience`, `/code-structure-review`, `/sprint-close`; fix CRITICAL/HIGH findings |
| 7.3 | Full regression: build, lint, unit, integration suite, `daemon-job.integration.test.ts`, CI SAST |
| 7.4 | Decide promotion of the verified build to the beta environment (`scripts/promote.sh --suffix prod-beta`), which also needs the new env vars there |

## 3. Test plan

### 3.1 Tiers

- **Unit (CI):** every new module is written with injected dependencies (Fly client, `statfs`, `du`,
  clock, Mongo via the repo's `fakeDb()` style as in `scheduler.unit.test.ts`), so nothing needs a
  network or a real machine.
- **Integration (real Mongo, no LLM):** limits/reset routes, report build over seeded data, waker,
  sampler upsert, anomaly relay to a copilot mailbox. Unique `missionId`/`userId` per test, cleaned up
  with `deleteMany`. Run locally and on dev, as today.
- **LIVE smoke on the dev deployment:** steps 1.1, 2.7, 5.1, 5.2, 6.3. These are the only tests that
  exercise real Fly resizes, real OOM, a real volume and real Atlas.
- **Not tested:** prompt and skill wording, the copilot's choices (CLAUDE.md), so no test asserts what
  the LLM says.

### 3.2 The upgrade service test matrix (step 2.3)

Happy path; renew with the same shape (no Fly calls, expiry moved, reminder replaced); different shape
(resize); revert; over max size; invalid or missing duration; cap reached (exact boundary, one minute
over); cooldown (rejected inside 5 min, allowed after; renewal exempt); concurrent request (409); stale
claim (>5 min) becomes a failed resize; Fly stop fails (no state change, no segment change); delete
succeeds and provision fails (mission `error`, segment closed, `resize-failure` raised); control plane
restarted mid-resize (claim recovered by the sweeper); expiry while the mission is suspended (nothing
to revert, no double-close); requester not in the roster (rejected); reason with control characters and
over-length (sanitised); manual suspend during an upgrade (segment closed, `upgrade` cleared); scheduler
auto-resume of an upgraded-then-suspended mission (default machine).

### 3.3 Regression guards

- Guard test that raw Fly lifecycle functions are used only through `machine-lifecycle.ts`.
- `missionLifetimeCostUsd()` and the #49 ceiling tests unchanged and green (Decision 1 is decoupled).
- The existing anomaly relay tests stay green with the new categories.

## 4. Security plan

Triggers from CLAUDE.md, applied to this work:

| Trigger | Where | Handling |
|---|---|---|
| New external HTTP call | Fly Machines API: resize path and one machines-list call per tick (existing Fly client and token); Atlas `listDatabases`/`dbStats` (existing Mongo credentials) | No user-influenced URL; no new secret; the control-plane token never reaches the execution plane |
| New public/IPC endpoint | `POST /api/mission-copilot/resources/*` (machine-to-machine, before `requireAuth`) | Behind `verifyMissionToken`, which fails closed on an empty signing key and derives the token from the claimed `missionId`; add tests that a token for mission A cannot act on mission B |
| New operator endpoints | `PATCH /:id/limits/upgrade-reset`, `GET /:id/machine-runtime` | `requireAuth` + `userFilter(req)`; cross-user access returns 404 (test); reset is a separate writer no execution-plane tool can reach (F-025 pattern) |
| New subprocess | `du` in the sampler | `execFile`, fixed arguments and path, no shell, no agent-controlled input, timeout, daemon user (which already holds ACL access) |
| New MongoDB queries with external input | `missionId` from the request body; `requestedByAgentId` | Used only as values, scoped by `missionId` after token verification; `requestedByAgentId` validated against the mission roster |
| New env vars | `PLATFORM_ADMIN_USER_IDS`, `RESOURCE_REPORT_HOUR_UTC`, `ATLAS_STORAGE_LIMIT_MB` | Control-plane only, none is a secret, none forwarded to execution-plane machines (`fly-machines.ts` env block untouched); documented in CLAUDE.md |
| Untrusted text into privileged readers | Agent-authored `reason` flows into the operator audit and copilot mailbox | Length cap, strip control characters, rendered as escaped text in the cockpit, quoted in the copilot-facing message |
| Cross-user leakage | Reports, alerts, Atlas block | Reports and relays are built per `userId`; Atlas totals and other-database names only for `PLATFORM_ADMIN_USER_IDS`; F-028-style multi-user regression tests |

**Threat model (`docs/security/threat-model.md`):** extend TB-19 (execution plane → control plane) with
the resource route and record that it can stop and re-create the mission's own machine; add a new
boundary (TB-22) for the control plane's Fly-mutation path used by a mission-originated request, with
STRIDE rows: spoofed mission (token), tampering (shape validation, ceilings), repudiation (audit post +
segment record with `requestedByAgentId`), information disclosure (per-user scoping), denial of service
(cooldown, one-resize claim, 24 h cap, max size), elevation (Tier B copilot-only, no schema field for
`missionId`). Update the DFD and the "Last updated" header.

**Findings (`docs/security/findings.md`):** add a MEDIUM/LOW finding (next ID F-031) — "the
mission-copilot can trigger a paid machine resize without confirmation", recorded as mitigated by
structural bounds rather than a confirmation gate: max 4 CPU / 16 GB, ≤ 60 min per window, 24 h
cumulative cap with operator-only reset, 5-min cooldown, audit on every change. Worst case is stated
in numbers: 24 h at the largest shape is roughly $6 per reset cycle at the display price table. Cross
reference F-025/F-026 (same class, same resolution path via CR-07). Note the sampler/`du` and the
per-tenant Atlas read as reviewed, not as findings.

## 5. Resilience plan

Add to `docs/operational-resilience.md` (new "Layer 10 — Resource oversight and machine upgrades",
plus rows in Layers 1, 2 and 5), each with detection, recovery and residual gap:

| Component | Failure | Design response |
|---|---|---|
| Resize | Control plane crashes between stop and re-create | `resizingSince` claim; sweeper treats claims > 5 min as failed → `error` status + `resize-failure`; operator Resume provisions the default machine |
| Resize | Fly API errors or quota | No state change on stop failure; surfaced to the copilot with the error text; audit message |
| Expiry revert | Control plane down at expiry | Sweeper in the 1-min tick and at startup: late, not never |
| Upgrade + suspend/resume | Operator or scheduler suspends an upgraded mission | Suspend closes the segment and clears `upgrade`; resume always default |
| Reminder | Delivery missed | Same scheduler catch-up as any scheduled message; expiry still happens regardless |
| Sampler | Statfs/du fails or hangs | Wrapped, timeout, never breaks the 60 s job-runner tick; report flags a missing sample as "monitoring blind" |
| Waker | Change Stream drops | Catch-up scan every 5 min and at startup |
| Monitor tick | Throws or overruns | Each emitter isolated (`Promise.allSettled`), errors logged with context, non-overlapping runs |
| Daily report | Control plane down at the report hour; double run | Startup catch-up; unique `(userId, date)` makes it idempotent |
| Atlas check | `listDatabases` denied; Atlas unreachable | Fallback to the app database with a warning; unreachable is logged, never crashes the tick |
| Copilot cost | A flood of relays wakes the copilot repeatedly | `shouldAlert` dedupe (24 h / level rise) and the copilot's own spend cap |
| Old machines | Missions running the old image lack the sampler | Report shows "no sample" until the mission is next resumed; never an error |

Gap table: **close G-4** (Fly Volume disk monitoring) and the Atlas-storage monitoring gap; **add**
G-9 "`conversationMessages` grows without bound (compaction only flags)" (real driver of Atlas usage,
see ADR-0032) and G-10 "Fly keeps only ~5 machine events, so an OOM exit is missed if the control plane
is down for longer than several restarts". Add runbook entries: *upgrade or resize failure*, *Atlas
storage alert*, *disk-pressure alert*, and update the existing "Fly Volume full" entry.

## 6. Documentation plan (same commit as the code it describes)

| File | Update | Step |
|---|---|---|
| `CLAUDE.md` | Env vars (`PLATFORM_ADMIN_USER_IDS`, `RESOURCE_REPORT_HOUR_UTC`, `ATLAS_STORAGE_LIMIT_MB`); Storage list (`machineSegments`, `missionResources`, `platformResources`, `resourceAlertState`, `resourceSnapshots`); sprint list entry | 1.2, 5.1, 7.1 |
| `MAGI_V3_SPEC.md` | §6 tool table: `RequestResourceUpgrade` (Tier B); skills; anomaly categories; resource sampling | 2.5, 5.1 |
| `MAGI_V3_ROADMAP.md` | Sprint row; near-term candidates rows resolved | 0.2, 7.1 |
| `docs/implementation-history.md` | Sprint section with key files and design rationale | 7.1 |
| `docs/deployment.md`, `secrets.env.template`, `scripts/bootstrap.sh`, fly toml `[env]` | The three env vars and where each environment sets them; note `PLATFORM_ADMIN_USER_IDS` must be set for the Atlas alert to reach anyone | 5.2 |
| `docs/operational-resilience.md` | Section 5 above | per step, 7.1 |
| `docs/security/threat-model.md`, `docs/security/findings.md` | Section 4 above | 2.4, 3.1, 7.1 |
| `docs/code-structure.md` | New files and the "do not grow" note for `mission-copilot-tools.ts` / `missions.ts` | 7.2 |
| ADR-0031 / ADR-0032 | Status Accepted, sprint number, any design change made during implementation recorded in the ADR itself | 0.2, as needed |
| Skills | `request-resources`, four copilot team skills, edits to three existing ones | 4.1, 6.2 |

## 7. Dependencies and critical path

```
1.1 waker ─────────────────────────────┐
1.2 thresholds ─┬─ 5.1 sampler ─┐      │
1.3 categories ─┤               ├─ 5.4 tick ─ 6.1 report ─ 6.2 copilot ─ 6.3 LIVE
1.4 index ──────┘  5.2, 5.3 ────┘
2.1 shapes ─ 2.2 segments ─ 2.3 service ─ 2.4 route ─ 2.5 tool ─ 2.7 LIVE ─ 3.1 ─ 3.2/3.3 ─ 4.1
```

ADR-0031 (Phases 2-4) and the ADR-0032 alerts (Phase 5) share only Phase 1, so they can proceed in
either order; the daily report needs both. The waker (1.1) is worth shipping first on its own because it
repairs the existing gap where relayed anomalies never wake the copilot.

## 8. Risks

| Risk | Mitigation |
|---|---|
| The resize is the first mission-originated destructive Fly action | Small blast radius by design (own machine, same volume, default fallback); LIVE test on a throwaway mission before any real one; the sweeper and claim logic are unit-tested before the route exists |
| Fly validity rules drift from our table | Route surfaces Fly's own error verbatim; table re-verified when implementing (ADR-0031 open item) |
| Many call sites bypass segment tracking | Step 2.2 routes them all through one module and adds a guard test |
| Report becomes noisy | Flags computed deterministically with dedupe; the copilot's mental map suppresses repeats; thresholds live in one file for tuning |
| Old and new image versions coexist | Section 9 rollout order; every reader tolerates missing data |
| `conversationMessages` keeps growing regardless | Alert only warns; tracked as G-9 and a follow-up ADR |

## 9. Rollout order and version skew

1. Control plane first (waker, route, sweeper, monitor tick): every new route is additive and the
   existing daemon image never calls it.
2. Then the execution-plane image (sampler, Tier B tool, `request-resources` skill) via
   `scripts/deploy-missions.sh`. New missions pick it up immediately; running missions pick it up on
   their next resume, so the skill and tool appear per mission at different times.
3. A new daemon talking to an old control plane gets a 404 from the route; the tool turns that into a
   clear "upgrades not available yet" message.
4. Beta environment last, after the dev LIVE checks and the `/security-review` pass, with the new env
   vars set there first.

## 10. Definition of done

All step tests green in CI (quality + SAST); every LIVE check recorded; `/security-review`,
`/operational-resilience`, `/code-structure-review` and `/sprint-close` clean or findings logged;
threat model, findings, resilience document, CLAUDE.md, SPEC, ROADMAP, deployment doc and both ADRs
updated; issue #31 commented with the outcome of step 2.7 and closed or reframed; the two follow-up
issues filed.
