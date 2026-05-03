# Discarded Ideas

Design alternatives that were considered and rejected, or implementation plans that were superseded
by what was actually built. Kept for reference — they explain *why* the current design is what it
is, even though the proposals themselves were never implemented.

## Contents

| File | What it contains | Why discarded |
|------|-----------------|---------------|
| [sprint-plans.md](sprint-plans.md) | Full pre-implementation plans for Sprints 0–15, including original designs for Temporal orchestration, Redis mailbox, MinIO artifact store, and MockLLMProvider testing | All sprints complete; the code is the truth; superseded designs documented in ADR-0001 and ADR-0006 |

## Active ADRs for superseded technology

Two ADRs record decisions that were later reversed. They live in `docs/adr/` (not here) because
they are decision records, not discarded ideas — the *reason* they were superseded is itself a
decision worth preserving:

- [ADR-0001](../adr/0001-orchestration-temporal.md) — Temporal → pm2 + node-cron
- [ADR-0006](../adr/0006-mailbox-redis-streams.md) — Redis Streams → MongoDB Change Streams
