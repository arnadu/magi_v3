# ADR-0001: Orchestration Engine — Temporal

## Status
Accepted

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
