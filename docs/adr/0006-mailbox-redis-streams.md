# ADR-0006: Inter-Agent Messaging — Redis Streams with Consumer Groups

## Status
Accepted — Sprint 2 uses MongoDB as a temporary mailbox backend (see note below)

## Context

Agents need to exchange structured messages (task requests, data requests, results, alerts)
with durable, ordered, at-least-once delivery. Requirements:
- Messages must survive agent or worker restarts
- Delivery must be acknowledged; unacknowledged messages must be redelivered
- Messages must be delivered in order per sender
- A `mailbox-service` must bridge delivery to Temporal Signals so the agent workflow wakes up

Candidates evaluated:
1. **Redis Streams with consumer groups** — append-only log, ordered delivery, `XACK`-based
   at-least-once semantics, consumer group redelivery on death
2. **MongoDB-based queue** — simple polling; no native consumer groups
3. **Temporal Signals only** — couples message storage to workflow state; no independent
   queryability; fan-out requires custom logic

## Decision

Use **Redis Streams with consumer groups**. Each agent has a dedicated stream
`mailbox:{agent_id}`. The `mailbox-service` reads streams via consumer group, delivers each
message by firing a Temporal Signal on the target agent's workflow, and `XACK`s only after
the Signal has been accepted.

Temporal Signals alone were rejected because: (1) they cannot be queried independently of
the workflow, (2) they do not provide a durable append-only log, and (3) fan-out (one sender,
multiple recipients) requires custom routing that Redis Streams handles natively.

MongoDB polling was rejected for latency reasons — polling intervals introduce unnecessary
delay for time-sensitive alerts, and Redis is already in the stack for distributed locking.

## Consequences

- Redis is a required infrastructure component alongside MongoDB and Temporal.
- `mailbox:{agent_id}` is the per-agent stream key; consumer group name is `magi-workers`.
- Pending entries list (PEL) tracks unacknowledged messages; `mailbox-service` reclaims
  stale PEL entries via `XAUTOCLAIM` after a configurable timeout.
- `XACK` is called only after the Temporal Signal is accepted by the workflow, ensuring
  no message is lost between Redis delivery and workflow wakeup.
- `SendMailboxMessage`, `ReadMailbox`, `AckMailboxMessage` tools wrap the Redis client;
  they are available in both loop tiers.
- Message IDs are stable across redelivery (Redis stream entry IDs); agents can detect
  and ignore duplicate deliveries using the message ID.
- In integration tests, Redis Streams are tested against a real Redis instance started
  by the test harness (not mocked).

## Sprint 2 Note — MongoDB Mailbox Stopgap

Sprint 2 implements the mailbox as a simple MongoDB collection (`mailbox` documents) rather
than Redis Streams. This allows multi-agent communication to be proven end-to-end without
adding Redis as a dependency before Temporal is also ready.

The four mailbox tools (`ListTeam`, `ListMessages`, `ReadMessage`, `PostMessage`) are defined
against a `MailboxRepository` interface. Sprint 4 swaps the MongoDB implementation for Redis
Streams without changing the tool API or agent behaviour. Sprint 3 (web/fetch/artifacts)
continued using the MongoDB stopgap.

MongoDB was chosen as the stopgap (rather than skipping messaging entirely) because agents
need a real mailbox to make the outer loop meaningful — a stub that cannot actually deliver
messages to a second agent running concurrently is not useful for testing the design.
