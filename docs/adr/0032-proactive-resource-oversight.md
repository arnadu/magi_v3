# ADR-0032 — Proactive multi-resource oversight by the control-plane copilot

**Status**: Proposed — a few implementation-time checks remain (Open questions).
**Sprint**: TBD (candidate: same push as ADR-0031, right after 28f)
**Date**: 2026-09-20
**Related**: [ADR-0031](0031-temporary-resource-upgrades-vm-cost.md) (temporary machine upgrades).
Designed together and likely shipped together, but separate: ADR-0031 scales one mission's machine on
request; this ADR is the control-plane copilot's ongoing monitoring of every mission a user owns —
LLM spend, machine upgrades, per-mission disk, and MongoDB Atlas storage. The daily report and the
upgrade alerts read ADR-0031's Decision-1 dataset and its 24 h cap.

---

## Context

- **The control-plane copilot is purely reactive.** It wakes on a MongoDB Change Stream over its own
  mailbox (`copilot-daemon.ts:204-429`), but the daemon is only *started* from the `/message` route
  (`ensureCopilotRunning`, `copilot-router.ts:109-122`, called at `:160`). So anything posted to
  `copilot-{userId}` while no daemon is running — including today's hard-anomaly relays from
  `AnomalyRecorder` (`anomaly.ts:120-132`) and any scheduled message — sits unread until the user next
  messages the copilot. This is an existing gap, not only a prerequisite for the daily report.
- **Two of the four resources have no instrumentation.** No disk-usage measurement exists anywhere
  (G-4); the only resource logging is `process.memoryUsage()` every 60 s (`daemon.ts:514`, log lines
  only). No Atlas storage measurement exists either, although an M0 (512 MB) quota outage has already
  broken login once (`docs/operational-resilience.md`, fixed reactively; monitoring still listed open).
  LLM spend and machine runtime already have data (`llmCallLog`/`missionStats`; ADR-0031's dataset).
- **What the control-plane copilot can do today** (`copilot-tools.ts`): read tools (`ListMissions`,
  `GetMissionStatus`, `ReadMissionMailbox`, `ReadMissionLog`, `ReadMissionFile`) and `ProposeAction`
  (operator-confirmed) with types including `suspend_mission`, `write_mission_file`,
  `create_schedule` (the only way it can message a mission's agents), `pause_agent`,
  `set_mission_budget`. Anything mutating already needs confirmation, so this ADR adds no
  confirmation infrastructure. It has no tool to see disk, Atlas or upgrade data.
- **Skills and prompt conventions already work for it.** `provisionCopilotSkills()`
  (`copilot-daemon.ts:143-198`) copies platform skills and the team skills in
  `config/teams/copilot/skills/` (today `cost-management`, `mission-monitoring`, `mission-recovery`,
  `schedule-management`, …) into its skills folder; its system prompt (`config/teams/copilot.yaml`)
  already has an anomaly-handling section and an "Anomaly log" in its `initialMentalMap`.
- **`AnomalyRecorder`** (`anomaly.ts:51-137`) always persists to `missionAnomalies`, notifies the
  mission's own copilot for every severity, and relays to `copilot-{userId}` (mail from `"system"`,
  subject `Anomaly (hard): <category> — mission <id>`) only for `severity: "hard"`. The control plane
  already depends on `@magi/agent-runtime-worker`, so it can construct the same recorder.
- **There is a platform-admin notion** (`req.isAdmin` for `CONTROL_API_KEY` callers, `auth.ts`) but no
  stored admin user — the Atlas cluster is shared by all users, so its alert needs an explicit
  recipient.

## Decision

**1. Wake the copilot for any mail addressed to it (fixes the gap for all sources).** Extract
`ensureCopilotRunning` and its `runningDaemons` map out of `createCopilotRouter()`'s closure into
`control-plane/src/copilot-runtime.ts`. New `startCopilotWaker(db, ensureCopilotRunning)` (started
next to `startScheduler` in `index.ts`) opens a Change Stream on `mailbox` for inserts whose
`missionId` matches `^copilot-` and `to` includes `"copilot"`, calling `ensureCopilotRunning(userId)`.
It also runs a catch-up scan on startup and every 5 min (unread copilot mail whose user has no running
daemon), so a dropped stream or a control-plane restart loses nothing. This replaces patching
`scheduler.ts`'s `deliver()`: one mechanism covers anomaly relays, scheduled messages and reports.

**2. Instrumentation.**
- **Per-mission disk (closes G-4).** New `agent-runtime-worker/src/resource-sampler.ts`, called from
  the job-runner tick that already runs every 60 s (`daemon.ts`, next to `logMemoryUsage`): `fs.statfs`
  on `AGENT_WORKDIR` (verify it is the volume mount) → upsert `missionResources`
  `{missionId, diskUsedBytes, diskTotalBytes, rssMb, runningJobs, updatedAt}`. `runningJobs` needs the
  module-level counter (`daemon.ts:145`) exposed through a getter. Failure never breaks the tick.
- **Atlas storage.** In the control plane's 5-min tick (Decision 4): `dbStats` on the app database
  plus a per-collection size breakdown, compared with `ATLAS_STORAGE_LIMIT_MB` (env, default 512),
  upserted as `platformResources` `{_id: "atlas", usedBytes, limitBytes, collections: [{name, bytes}],
  updatedAt}`.
- **`GetMissionStatus`** (`copilot-tools.ts:190-225`) additionally returns machine config, time on
  it, upgraded time used / cap (ADR-0031), latest disk sample and its age.

**3. Thresholds and dedupe live in one file**, `agent-runtime-worker/src/resource-thresholds.ts`
(constants, no config surface for now), imported by both the daemon and the control plane.
Alert state is kept in `resourceAlertState` `{key: "<missionId|platform>:<category>", level,
lastAlertAt}`: an alert fires when the level rises or 24 h have passed at the same level; the key is
deleted when the value falls 5 points below the threshold, so a recovered condition re-alerts fresh.

**4. Real-time alerts.** Reuse `AnomalyRecorder`: new `AnomalyCategory` values below. Soft alerts
reach the mission's own copilot and the daily report only; hard alerts are also relayed to
`copilot-{userId}` (and, with Decision 1, wake it).

| Category | Emitter | Trigger (default) | Severity | Handled by |
|---|---|---|---|---|
| `disk-usage-high` | daemon sampler | volume ≥ 80% / ≥ 90% | soft / hard | `disk-pressure` |
| `spend-cap-near` | control-plane tick, from `missionStats` totals vs the mission cap | ≥ 90% / ≥ 98% of cap | soft / hard | `cost-management` |
| `spend-spike` | control-plane hourly, from `llmCallLog` | 24 h spend > 3× trailing 7-day daily average and > $5 | soft | `cost-management` |
| `upgrade-cap-near` | control-plane tick, from ADR-0031 segments | ≥ 80% of the 24 h cap | soft | `vm-upgrade-oversight` |
| `upgrade-cap-reached` | ADR-0031 route, on rejection | request rejected by the cap | hard | `vm-upgrade-oversight` |
| `upgrade-idle` | control-plane tick | upgraded machine, no conversation activity **and** `runningJobs = 0` for 30 min | soft | `vm-upgrade-oversight` |
| `resize-failure` | ADR-0031 route | machine stopped but re-create failed | hard | `mission-recovery` |
| `atlas-storage-high` | control-plane tick | cluster ≥ 70% / ≥ 85% of limit | soft (report only) / hard | `atlas-storage` |

Mission-level alerts use a control-plane `AnomalyRecorder` built like `constructAnomalyRecorder`
(`daemon-boot/mission-owner.ts`): the mission's mailbox, `MISSION_COPILOT_AGENT_ID` when the mission
has one, and the owner's `copilot-{userId}` mailbox. `atlas-storage-high` has no mission, so it is
posted directly to the copilot mailbox of each user in the new env var **`PLATFORM_ADMIN_USER_IDS`**
(comma-separated Firebase UIDs; empty → a startup warning and no Atlas alerts or report section).
`upgrade-idle` requires the `runningJobs` sample: a long background job legitimately has no LLM
activity.

**5. Daily report.** New `control-plane/src/resource-monitor.ts` (`startResourceMonitor(db)`, started
with the scheduler) runs the 5-min tick above and, once per day at `RESOURCE_REPORT_HOUR_UTC`
(default 12), builds one report per user who owns a non-destroyed, non-draft mission
(`missions.distinct("userId", …)` — no `listUsers` helper needed). `buildDailyReport(db, userId, now)`
returns a typed `DailyReport`; `renderDailyReport()` turns it into the text below and it is posted to
`copilot-{userId}` (`from: "system"`, `to: ["copilot"]`, subject `Daily resource report — YYYY-MM-DD`).
It is written first as a `resourceSnapshots` document `{userId, date, missions: {id: {diskUsedBytes,
llmTotalUsd, upgradedMs}}, atlasBytes?}` with a unique `(userId, date)` index, which makes it
idempotent across restarts and supplies yesterday's numbers for growth rates. If the control plane was
down at the report hour, the first tick after start builds any missing report for today. Spend uses the
same aggregation as `GET /api/missions/stats` (extracted into a shared helper); caps come from each
mission's team config as in `GET /:id/limits`. The Atlas block appears only in reports for
`PLATFORM_ADMIN_USER_IDS`. The report is always sent, with an empty flags list when all is well.

```
Daily resource report — 2026-09-20 (last 24 h)

FLAGS (2)
  ! meteo-textbook  disk 8.1 / 10 GB (81%), growing ~0.4 GB/day, full in ~5 days
  ! tutor           upgraded machine idle 47 min (performance 2 CPU / 8 GB, expires in 38 min)

PLATFORM
  MongoDB Atlas   212 / 512 MB (41%)   +6 MB/24 h, ~50 days to full
    largest: llmCallLog 118 MB · conversationMessages 61 MB · agentTurnStats 14 MB

MISSIONS
  mission          status   LLM 24h  LLM total / cap       machine now            upgraded / 24 h cap  disk         last activity
  gold-digest-v2   running  $4.12    $161.40 / $250  (65%)  shared 1 CPU 1 GB      0.0 h                2.1 / 10 GB  4 min ago
  meteo-textbook   running  $9.80    $88.10 / $150   (59%)  shared 1 CPU 1 GB      2.5 h                8.1 / 10 GB  21 min ago
  tutor            running  $1.35    $12.60 / $50    (25%)  performance 2 CPU 8 GB 5.0 h                1.2 / 10 GB  47 min ago

UPGRADES (ADR-0031 dataset)
  2 requests, 6 renewals, 0 rejected; 7.5 h upgraded in total
  meteo-textbook: 1 request + 2 renewals, shared 2 CPU / 4 GB, 2.5 h, asked by lead-analyst ("pandas transform")
  tutor:          1 request + 4 renewals, performance 2 CPU / 8 GB, 5.0 h, asked by notebook-agent
  Active now: tutor, expires in 38 min
```

Flags are computed by the control plane, never by the LLM: any mission with disk ≥ 80% or projected
full within 7 days; Atlas ≥ 70%; spend ≥ 80% of cap; an upgrade idle as defined above; upgraded time
≥ 80% of the cap; upgraded time on ≥ 5 of the last 7 snapshots (a chronic upgrade, a sign the
mission's default size is wrong); a running mission whose resource sample is older than 5 min
(monitoring is blind); any rejected upgrade request. Suspended missions show status and spend, with
disk marked "last sample <age>".

**6. What the copilot does with it: extend its own conventions, in three places.**
- **System prompt** (`config/teams/copilot.yaml`) gets a "Resource oversight" section next to
  "System-triggered anomalies": what the daily report and the new categories are, that a report with
  no flags is answered with a one-line all-clear in the control chat (silence is ambiguous — it
  cannot mean "fine" and "the job died" at once), and that the digest lists flags first and stays
  under ~120 words with at most one proposed next step.
- **Mental map** (`initialMentalMap`) gets a "Resource oversight" table — `mission | category | first
  flagged | status | last action` — so a flag that persists is not re-announced every morning, and
  the same flag on ≥ 2 missions is treated as a platform problem, as the anomaly section already
  does for categories.
- **Skills**, as *team* skills in `config/teams/copilot/skills/` — not platform skills, which are
  copied into every mission's shared folder and would appear in every mission agent's prompt:

| Skill | Description (frontmatter) | Playbook contents |
|---|---|---|
| `daily-resource-report` (new) | How to read the daily resource report, decide what needs the operator's attention, write the digest, and keep the Resource oversight mental-map table current. | Order: flags → already-flagged check → digest → mental-map update; one-line all-clear; cross-mission pattern check. |
| `disk-pressure` (new) | Responding to a mission volume filling up: find what is growing, then choose cleanup, extending the volume, or suspending before writes fail. | The 90% alert body carries the top-5 directories (bounded `du`, run once by the sampler on crossing 80%). Logs/temp → propose `create_schedule` asking the mission's copilot to prune; git objects → `git gc`; agent data → extend the volume; ≥ 95% or projected full within 2 h → propose `suspend_mission`. |
| `atlas-storage` (new) | Responding to shared MongoDB storage pressure using the per-collection breakdown, and knowing which fixes need the platform owner. | Levers in order: lower `LOG_RETENTION_DAYS` (the pruner runs every 30 min; needs a control-plane env change and deploy, so the copilot tells the owner exactly which value), clear the largest log collection, move up an Atlas tier. Read-only: the copilot has no DB tool. |
| `vm-upgrade-oversight` (new) | Reviewing machine-upgrade activity: judge whether a mission holds a bigger machine than it needs, handle cap-near and cap-reached, and recognise when the default size should change. | `upgrade-idle` → propose a message to the mission's copilot not to renew; cap-near → check the reason pattern; cap-reached → explain that only the operator can reset it in the Limits panel (ADR-0031 Decision 7); chronic flag → propose `save_session_config` raising the default machine (only after the mission is suspended, as that action already requires). |
| `cost-management` (extend) | Existing skill, LLM cost. | Add `spend-cap-near` (check burn rate, then `pause_agent` on the runaway or `set_mission_budget` within the ceiling) and `spend-spike` (per-agent attribution from `missionStats`). |
| `incident-triage` (extend) | Existing skill, shared with the mission-copilot. | Add one section per new category naming the skill that handles it (table in Decision 4). |

Anything mutating goes through `ProposeAction`, unchanged. Extending a Fly volume (Fly volumes can grow,
not shrink) would need a new `extend_volume` action type; whether that is in scope is an open question.

## Alternatives considered

- **Patch `scheduler.ts`'s `deliver()` to wake the copilot** (this ADR's earlier direction). It only
  covers scheduled messages; the Change Stream waker also fixes anomaly relays and reports.
- **A new alerting pipeline separate from `AnomalyRecorder`.** Rejected: the existing pipe already
  reaches the right mailbox for the right user.
- **Compute flags in the LLM from raw data.** Rejected: thresholds are arithmetic; the LLM's value
  is judgment about what to do.
- **One monolithic `resource-oversight` platform skill.** Rejected: per-situation skills load on
  demand, and a platform skill would reach every mission agent.
- **A new objectives-style structure for the copilot's own responsibilities.** Rejected: its
  mental-map convention already solves "what have I already flagged".
- **Skipping Atlas monitoring because the last outage got a fix.** Rejected: the fix was reactive
  and `operational-resilience.md` still lists the gap.

## Open questions

- **Fly OOM detection.** `unclean-restart` should carry an OOM flag if Fly's machine exit event reports
  an OOM kill, so the copilot can point at a resource request (issue #31). Nothing in the code reads
  Fly exit events yet; verify the field before relying on it.
- **Atlas accounting.** Which `dbStats` figure matches what Atlas counts against the M0 quota
  (`dataSize + indexSize` vs `storageSize`) — verify once against the Atlas UI.
- **`llmCallLog` query cost.** The hourly `spend-spike` aggregation needs an index on
  `(missionId, createdAt)`; verify it exists, given that collection is what filled the quota before.
- **Disk sampling details.** That `AGENT_WORKDIR` is the volume mount, and that the daemon user can
  `du` enough of it to name the largest directories (agent home directories are ACL-restricted).
- **`extend_volume`.** Add a `ProposeAction` type for it now, or leave volume growth to the operator
  running `flyctl volumes extend` at first.
- **Report hour and timezone.** One UTC hour (default 12) until users have a stored timezone.
- **Skill playbook wording.** The decision tables above fix the structure; the actual text needs your
  review, since it encodes operational judgment.
- **A fifth resource** (your "etc."): the mechanism (waker, sampler, thresholds, report sections) is
  generic; confirm nothing else should be in the first delivery.

## Consequences

- New: `copilot-runtime.ts`, `resource-monitor.ts` (control plane); `resource-sampler.ts`,
  `resource-thresholds.ts` (agent-runtime-worker); collections `missionResources`, `platformResources`,
  `resourceAlertState`, `resourceSnapshots` (prune snapshots and alert state with the existing
  log pruner); eight new `AnomalyCategory` values; extended `GetMissionStatus`.
- New env vars, documented in `CLAUDE.md`: `PLATFORM_ADMIN_USER_IDS`, `RESOURCE_REPORT_HOUR_UTC`,
  `ATLAS_STORAGE_LIMIT_MB`.
- `config/teams/copilot.yaml` grows a prompt section and a mental-map table; four new team skills and
  two extended ones (content work, not only code).
- Closes G-4 and the Atlas-storage gap in `docs/operational-resilience.md`, which gets entries for
  the new components: a failing sampler or check never breaks its host tick; the report is idempotent
  per `(user, date)`; the waker has a periodic catch-up so a dropped Change Stream loses nothing.
- Fixes the existing "relayed anomalies never wake the copilot" gap for the categories that already exist.
- No new confirmation infrastructure; `ProposeAction` covers every mutating response.

## Related

- [ADR-0031](0031-temporary-resource-upgrades-vm-cost.md) — the runtime dataset, the 24 h cap and the
  upgrade categories this ADR reports on
- `packages/agent-runtime-worker/src/anomaly.ts`, `daemon-boot/mission-owner.ts` — the relay this ADR
  reuses (ADR-0020, F-028)
- `packages/control-plane/src/copilot-router.ts`, `copilot-daemon.ts`, `scheduler.ts`, `missions.ts`
  (`GET /stats`, `GET /:id/limits`), `copilot-tools.ts` — code this ADR extracts from or extends
- `config/teams/copilot.yaml`, `config/teams/copilot/skills/` — prompt and skills this ADR extends
- `docs/operational-resilience.md` — the Atlas quota incident and the open G-4 / Atlas gaps
- Issue #31 — likely closed or reframed once ADR-0031 and this ADR both exist
