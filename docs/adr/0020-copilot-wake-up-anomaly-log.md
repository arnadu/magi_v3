# ADR-0020 — Copilot wake-up triggers and a persisted anomaly log

**Status**: Accepted
**Sprint**: 26c
**Date**: 2026-07-22

---

## Context

Asked to audit what already wakes the mission copilot and the control-plane copilot for
operational problems — failed scheduling, tool failures, a runaway agent, a doom loop, VM
resources exceeded — the honest answer was: almost nothing, system-triggered. `onLimitAlert`
(hard/soft `LimitRule` breaches) was the only real automated wakeup. `onAgentError` looked
SSE-only and dead-ended at the dashboard. Everything else the roadmap has named as a failure mode
(missed cron fires — G-3, background job failures — issue #3, VM/resource exhaustion — G-4/G-5)
had no trigger at all, relying entirely on the mission copilot noticing during its own
self-scheduled alignment review.

Two findings emerged only once the actual code was read closely, not just grepped:

1. **`onAgentError` was not actually the whole story.** `orchestrator.ts` independently posts to
   mailboxes on two of its own inline code paths — a wall-clock timeout (`ctrl.abort()`) and a
   dispatch-level crash (`runAgent(...).catch()`) — entirely separate from the `onAgentError`
   callback, which is SSE-only. So "agent crash"/"runaway agent" already had real, working mailbox
   delivery; it just lived in a different module than expected, duplicated per site, and shared a
   second problem with `onLimitAlert`:

2. **The control-plane copilot's routing was worse than dead code.** All three existing posts
   (`onLimitAlert`, orchestrator's timeout, orchestrator's dispatch-crash) targeted a single
   **global** mailbox — `missionId: "copilot"`, `to: ["copilot"]` — gated by a `COPILOT_MISSION_ID`
   env var. Grepping `fly-machines.ts`'s env-injection block for execution-plane machines found zero
   occurrences: the env var is never set in production, so this relay path is inert today. But even
   if it had been set, every mission from every user would land in one shared inbox — a cross-user
   information leak (mission names, agent IDs, breach details) under the Sprint 23 multi-user model
   (`copilot-{uid}`, one copilot per user). This reads as a holdover from a pre-Sprint-23 single-
   copilot design, never updated after that migration.

3. **G-3 ("no catch-up for missed cron fires") in `operational-resilience.md` was stale.**
   Scheduling had already moved off the execution-plane daemon's in-memory `node-cron` to the
   control plane (`packages/control-plane/src/scheduler.ts`) — always-on, polls
   `deliverAt <= now` every minute, with an immediate catch-up tick on startup. A missed fire from
   the daemon being down can't happen with this architecture. The real, narrower gap: `deliver()`'s
   failure path reopened a message to `pending` and retried forever with no attempt cap and no
   escalation — the same bug class Sprint 26 already fixed once for background jobs
   (`MAX_JOB_RECOVERY_ATTEMPTS`), not yet applied here.

Separately, discussed alongside this: if categories of anomaly-response guidance don't belong in
the system prompt (too long, paid every turn) or the mental map (per-mission, not general), they
need a skill — but skills are read-only, developer-maintained reference material, and both
copilots are themselves expected to make this same "which surface" placement call when authoring
*other* agents' prompts/skills/mental maps (`EditAgentMentalMap`, skill creation, template design).
That guidance didn't exist anywhere for either copilot before this ADR.

---

## Decision

### One recorder, `anomaly.ts`, three responsibilities per call

`packages/agent-runtime-worker/src/anomaly.ts` — `AnomalyRecorder.record()`:

```ts
export type AnomalyCategory =
  | "limit-breach" | "agent-crash" | "agent-timeout" | "llm-error"
  | "job-failure" | "scheduling-failure" | "unclean-restart";
export type AnomalySeverity = "hard" | "soft";
```

Every call: (1) persists to `missionAnomalies` (append-only, mirrors `llmCallLog`'s convention —
gives the cockpit Trace panel a real anomaly data source for the first time; today its "anomaly"
markers are just `agentTurnStats.status === "aborted"`), (2) mailbox-posts to the mission's own
copilot if one is present, (3) for **hard** severity only, relays to the owning user's
control-plane copilot mailbox (`copilot-{userId}`, resolved by reading the mission doc's `userId`
field directly — the same collection `daemon.ts` already reads for `teamFiles`, no env var
needed). Soft anomalies stay mission-local: the control-plane copilot's own prompt already
describes it as "a coarse, top-level check, not a diagnosis tool," and every soft blip from every
mission would defeat that.

This replaces `COPILOT_MISSION_ID`/`copilotMailboxRepo` everywhere it appeared
(`daemon.ts`, `orchestrator.ts`) with per-mission, per-user routing built from data the daemon
already has — fixing the dead pathway and the cross-user leak risk in the same change, not two.

### Wiring each trigger

- **`onLimitAlert`** (`daemon.ts`) — now calls `anomalyRecorder.record()` once; the mission-copilot
  mailbox post and the (conditional, hard-only) control-plane relay both happen inside `record()`,
  removing the inline duplicated logic that used to do both by hand.
- **`orchestrator.ts`'s timeout and dispatch-crash paths** — replaced their inline dual `.post()`
  calls with `config.anomalyRecorder?.record(...)` (new `agent-timeout` and `agent-crash`
  categories respectively). `OrchestratorConfig.copilotMailboxRepo` is removed; `onAgentError`
  stays as a pure SSE-push callback (`monitor.push("agent-error", ...)`) — recording the anomaly
  only once, at the dispatch-crash site that has `errMsg` first-hand, avoids double-recording the
  same event from two call sites.
- **LLM completion errors** (`daemon.ts`'s `onAgentMessage`, `am.stopReason === "error"`) — this
  was genuinely SSE-only before this ADR (the one part of the original "onAgentError is a dead
  end" finding that held up). Now also calls `anomalyRecorder.record()`, category `llm-error`,
  severity `soft` (transient — overloaded/rate-limited, self-heals) or `hard` (non-transient —
  auth/credits, needs the operator).
- **`job-recovery.ts`'s permanent-failure branch** (past `MAX_JOB_RECOVERY_ATTEMPTS`) — already
  notified the job's own `notifyAgentId`/`"user"`; now also calls `recordAnomaly` (optional param,
  category `job-failure`) so it's visible mission-wide, not just to whoever happened to own the
  job.
- **`scheduler.ts`'s delivery failure path** (control plane) — new `MAX_DELIVERY_ATTEMPTS = 5`
  counter on the `scheduled_messages` doc, mirroring `MAX_JOB_RECOVERY_ATTEMPTS`'s reasoning past
  the cap, marks the message `"failed"` instead of reopening to `"pending"` forever, and records a
  `scheduling-failure` anomaly (a fresh, mission-scoped `AnomalyRecorder` built per failure, since
  this loop spans many missions/users in one tick — cheap relative to how rare a permanent failure
  is). `deliveryAttempts` resets to `0` on a successful cron re-arm, so an old, self-healed failure
  streak doesn't carry into a later, unrelated one. **Found while writing the test for this**: a
  reopened-to-`pending` message was still due (`deliverAt` unchanged), so `deliver()`'s
  `while (true)` loop immediately re-claimed the same message on its very next iteration — all 5
  attempts burned in milliseconds within one tick, not spread across real minutes as intended,
  which defeats the point of a retry cap for a genuinely transient failure. Fixed by pushing
  `deliverAt` forward 60s (matching the tick cadence) on every reopen.
- **Unclean restart** (`daemon.ts`, the existing stale-PID-file detection at boot) — can't identify
  *why* the prior process died (that would need polling the Fly Machines API for OOM events — a new
  external dependency, deliberately out of scope here), but "the process didn't exit gracefully" is
  a real, free signal. Category `unclean-restart`, severity `soft` — treated as informational
  unless it recurs for the same mission, which the mission copilot's own anomaly log (below) is
  what would actually reveal.
- **Doom loop / runaway agent** — no new purpose-built detector. Already covered approximately by
  the existing soft limits (`warnLlmCallsPerTurn`, `warnConsecutiveZeroOutputTurns`), which now
  flow through the same unified `limit-breach` category.

### Guidance: a skill for the shared "how", a mental-map log for the mission-specific "what happened"

New platform skill `packages/skills/incident-triage/SKILL.md` — one section per category (what it
means, which tool to check first, which action tier it falls into), plus a worked example (the
objectives resume-overwrite incident from earlier this sprint: a copilot's own plausible-sounding
self-diagnosis was wrong; the real cause only surfaced from direct evidence). Shared by both
copilots — default-on for the mission copilot (opt-out via `disabledSkills`, unchanged); added to
`copilot-daemon.ts`'s `platformSkillsToCopy` allowlist for the control-plane copilot.

Both copilots' `INITIAL_MENTAL_MAP`/`initialMentalMap` gain a small `Anomaly log` section — a
freeform, agent-curated running log ("category, what I found, what I did"), seeded near-empty.
This is deliberately *not* a restatement of the skill's category list: the skill is developer-
authored, re-copied fresh on every provision (a later fix reaches every mission automatically),
and read on demand; the mental map is per-mission, agent-written, and paid for in full every
turn — content specific to *this* mission's own incident history belongs there, generic procedure
does not. Duplicating the runbook into the mental-map seed would freeze a stale copy per mission
with no propagation path, and cost context every turn regardless of whether an anomaly ever fires.

The same "skill vs. mental map vs. system prompt" placement test is now written down for the
copilots themselves, since both are expected to make this call when authoring *other* agents'
prompts/skills/mental maps: `mission-leadership` (mission copilot) gains a "Which surface" section;
`magi-template-design` (control-plane copilot, already had half of this — system-prompt-vs-skill —
via its existing "Omit: capability details" rule) gains the missing mental-map-vs-skill half. Both
cross-reference each other rather than duplicating the full rationale twice.

### Not changed

- `limits.ts` — pure/no-I/O, unchanged; only what calls it now also calls `anomalyRecorder.record()`.
- `packages/control-plane/src/missions.ts` — no changes; anomaly relay reads `userId` directly off
  the mission doc this file already writes.

---

## Consequences

- **The cockpit Trace panel gets a real anomaly data source for the first time** (`missionAnomalies`
  vs. `agentTurnStats.status === "aborted"`) — not wired into the UI in this pass; scoped as a
  fast-follow (additive, read-only, no architectural risk).
- **The control-plane copilot receives real, per-user-scoped, hard-severity anomalies for the first
  time in production.** Previously zero, silently.
- **A genuine security-relevant fix, not just a feature**: removes a cross-user mailbox-leak risk
  that existed in the code even though it was never triggered in practice (`COPILOT_MISSION_ID`
  unset). Logged as a found-and-fixed finding, not a new open one.
- **LLM completion errors (the one part of the original "SSE-only" finding that was accurate) now
  reach the mission copilot's mailbox** — closing the last real blind spot among the signals this
  ADR reviewed.
- **`operational-resilience.md`'s G-3 entry corrected** — the architecture it described (execution-
  plane in-memory `node-cron`, no catch-up) predates the control-plane scheduler migration and no
  longer matches the code; replaced with the narrower, real gap (no attempt cap on `deliver()`'s
  retry) and its fix.
- **Residual, explicitly accepted gap**: VM/resource exhaustion (OOM, disk full) still has no
  direct signal — `unclean-restart` is a coarse proxy ("the process died abnormally"), not
  attribution. Closing that fully needs Fly Machines API polling, a new external dependency,
  deliberately deferred rather than folded in here.
- **Verification**: unit tests for `anomaly.ts` (persist + mission-copilot-notify + hard-only
  relay), `job-recovery.ts`'s new anomaly call, and `scheduler.ts`'s attempt-cap state machine.
  Integration test proving a real `onAgentError`/`stopReason: "error"` path produces a
  `missionAnomalies` doc and reaches the correct `copilot-{userId}` mailbox, with a second user's
  mailbox asserted empty (no cross-talk). Full `npm run build && npm run lint && npm test` before
  commit.

---

## Related

- `docs/adr/0016-copilot-architecture.md` — the mission copilot's original design; this ADR extends
  its wake-up surface rather than changing its structural boundary
- `docs/adr/0017-cost-tracking-single-source-fresh-reads.md`,
  `docs/adr/0018-limit-configuration-single-source-fresh-reads.md` — the same "read the real,
  current source, don't cache/duplicate it" principle applied to metrics and config respectively;
  this ADR applies the analogous principle to *routing* (read the mission's real `userId`, don't
  rely on a static env var standing in for it)
- `packages/agent-runtime-worker/src/anomaly.ts` — `AnomalyRecorder`, `createMongoAnomalyRecorder`
- `packages/skills/incident-triage/SKILL.md` — category runbooks
- `packages/skills/mission-leadership/SKILL.md`,
  `config/teams/copilot/skills/magi-template-design/SKILL.md` — "which surface" placement guidance
