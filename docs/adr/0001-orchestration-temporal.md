# ADR-0001: Orchestration Engine — Temporal

## Status
Superseded — see note below

## Context

Agent lifecycles need to:
- Survive worker crashes and resume without data loss
- React to external triggers: scheduled timers, inbound mailbox messages, and critical alerts
- Support long-running operations (hours to days) without polling loops
- Provide activity-level retries and heartbeats for flaky external calls

Candidates evaluated:
1. **Temporal** — durable workflow engine with replay-based crash recovery
2. **BullMQ** — Redis-backed job queue with concurrency and retries
3. **Custom state machine** — ad-hoc MongoDB-persisted FSM with a polling worker

## Decision

Use **Temporal** as the orchestration engine.

The outer agent lifecycle (schedule trigger → outer loop → inner loop → wait → repeat) maps
directly to a Temporal Workflow with Activities. Temporal's replay-based execution gives us
crash recovery without writing custom checkpointing code. Built-in `scheduleWithCron`,
Signals, and Timers cover all our trigger types with first-class primitives.

BullMQ was rejected because it offers retries and queuing but not workflow-level durability:
a crashed worker loses the current in-flight state, requiring manual recovery logic that
duplicates what Temporal provides natively.

A custom FSM was rejected as premature complexity — it requires reimplementing exactly what
Temporal provides (replay, timers, signals, retries), with worse operational tooling.

## Consequences

- Temporal cluster required in all environments (dev server is a single binary; cloud is a
  managed Temporal Cloud or self-hosted cluster).
- Agents are Temporal Workflows; outer-loop and inner-loop tiers are Activities.
- Worker crash → Temporal replays the workflow history; the Activity resumes from the last
  successful checkpoint with no data loss.
- Schedules (`06:00` ingestion trigger) and Signals (`inbound_message`, `critical_alert`,
  `abort`) are first-class Temporal primitives.
- Temporal's event history is the authoritative audit log for all workflow state transitions.
- Learning curve: team must understand Temporal's determinism constraints (no random, no
  `Date.now()` in workflow code; side effects only in Activities).

## Superseded Note — Temporal dropped from roadmap (2026-02)

After Sprints 1–3, the case for adding Temporal before Sprint 7 is not strong enough to
justify the operational overhead. Reasons:

1. **Crash recovery is already solved.** `runInnerLoop` fires the `onMessage` callback
   after every message boundary, saving to MongoDB immediately. A process crash between
   messages loses nothing; the conversation is fully replayable from the DB.

2. **Hung tools are already handled.** `withTimeout` (default 120 s) wraps every tool call.
   A stalled tool is killed and the loop receives a clean error result.

3. **Scheduling does not need Temporal.** Cron-style triggers (`06:00 ingestion`) are
   handled by `node-cron` without introducing a separate cluster dependency.

4. **Mid-run interruption is premature.** The `critical_alert` interrupt pattern (Temporal
   Signal → `getSteeringMessages()`) solves a real problem, but the equity research scenario
   does not stress-test it until Sprint 7's 5-day unattended run. The right time to
   implement it is when a concrete failure is observed, not speculatively.

5. **Operational cost.** Temporal requires a separate server process (or Temporal Cloud
   subscription) in every environment. The complexity and learning curve are not justified
   until the system is running multi-day unattended missions and we have evidence that the
   simpler supervision approach is insufficient.

**What replaces it:**
- Process supervision: `pm2` (local dev) / `systemd` (server) for worker restart on crash.
- Scheduling: `node-cron` in the orchestrator process.
- Long-running stability: validated in Sprint 7's evaluation harness; Temporal re-evaluated
  at that point if the simpler approach proves insufficient.

BullMQ (also evaluated) was rejected for the same reasons: adding Redis as a dependency
just to get a job queue is not justified when MongoDB with Change Streams is already in
the stack and handles the mailbox and wakeup notification use case adequately.
