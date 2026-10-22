# agent-config

The shared contract between the packages: the Zod schema for team configs (`loadTeamConfig()`,
`parseTeamConfig()`), the canonical stored-document types and collection names (`src/stored/`),
the model defaults, and the env catalog that generates `docs/env.md`. Loaded on top of the root
`CLAUDE.md` when working in this package.

## Rules here

- No `process.env` anywhere in `src/` (tripwire T1): a team config is tenant input and must
  never reach the server environment.
- A new collection gets its document type and `COLLECTION_NAMES` entry in `src/stored/`, is
  reached through `storedCollection(db, key)` (tripwire T13), and is added to the list below —
  `tests/stored-collections.unit.test.ts` fails until the list and the code agree.
- Typed dotted paths: `field<T>()` for `$match`/`$set` keys, `ref<T>()` for aggregation
  expressions; a wrong path fails `tsc`.
- A new env var goes into `src/env-catalog.ts`; run `npm run docs:env`.

## Storage (MongoDB collections)

Every collection's name and canonical document type live in `src/stored/`;
code reaches a collection through `storedCollection(db, key)`, and a test keeps this list in step
with `COLLECTION_NAMES`.

- `missions` — one doc per mission: owner, structured config (ADR-0021), status, Fly machine/volume ids, spend cap and ceiling
- `missionConfigRevisions` — history of a mission's structured config, one doc per saved revision
- `users` — Firebase users seen by the control plane (uid, email, last login)
- `objectivesGoals` — one doc per mission: the authored objective tree and KPI definitions (ADR-0019)
- `objectivesEvents` — append-only task, KPI, cost and allocation events the objectives tree is folded from (ADR-0019)
- `missionAnomalies` — anomalies recorded by the daemon and the control plane (crash, timeout, scheduling failure, resource alerts)
- `conversationMessages` — full agent conversation history with compaction and reflection
- `mailbox` — inter-agent and operator messages
- `llmCallLog` — audit log of every LLM call with cost breakdown
- `scheduled_messages` — cron-based agent wakeups; documents with `origin: shared-schedules` are imported by the daemon from agents' `shared/schedules/*.json` files, and `kind: job` ones fire a background job instead of a message (ADR-0033 §3)
- `agentTurnStats` — per-turn (per-wakeup) statistics, upserted incrementally during a turn (LLM call count, tokens, cost, peak context, tool counts/errors, files written, messages sent, URLs visited); one doc per `(missionId, agentId, turnNumber)`
- `machineSegments` — runtime segments per machine shape (ADR-0031): one doc per stretch a mission's machine ran with one shape; drives the runtime cockpit tab and the cumulative upgrade cap
- `resourceAlertState` — per-alert de-duplication/hysteresis state for resource alerts (ADR-0032); one doc per `<missionId|platform>:<category>` key
- `missionResources` — latest per-mission resource sample (ADR-0032): disk usage, daemon RSS, in-flight background job count; upserted every 60 s by the daemon's job-runner tick; one doc per `missionId`
- `platformResources` — cluster-wide (not per-mission) resource samples (ADR-0032); today just `_id: "atlas"`: shared MongoDB Atlas storage usage and its per-database/per-collection breakdown, upserted by the control plane's 5-min resource-monitor tick
- `resourceSnapshots` — one doc per `(userId, date)` (unique index), written by the daily resource report (ADR-0032): per-mission `{diskUsedBytes, llmTotalUsd, upgradedMs}` plus `atlasBytes` for admins; its existence is the idempotency/send-claim for that user's report that day, and the last 7 days back the "chronic upgrade" flag and disk/Atlas growth-rate projections
- `copilotPendingActions` — control-plane copilot actions proposed via `ProposeAction` and not yet confirmed/dismissed (F-055); one doc per action, `_id` = action id, 7-day TTL on `createdAt`; claimed atomically by `POST /api/copilot/confirm`
- `missionStats` — lifetime per-agent totals (cost, LLM calls, turn count, consecutive zero-output turns), `$inc`-updated once at turn end; one doc per `(missionId, agentId)`
