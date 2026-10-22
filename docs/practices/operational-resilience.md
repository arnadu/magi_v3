# Operational resilience — working practice

Moved out of the root `CLAUDE.md`, which keeps the one-line triggers; this is the full text.

Operational resilience is applied **continuously during development**. These are the triggers — moments where you pause and reason about failure modes regardless of what feature you're building.

**New long-running process or background loop** — What happens if it crashes or hangs? Is there a watchdog or timeout? Does a stale PID or lock file block the next startup?

**New persistence write** — Is there an atomicity window where a crash leaves state inconsistent? What is lost vs. preserved if the process is killed mid-write? Is the write in a `.finally()` block?

**New scheduled or time-driven action** — What happens if the process is down when the trigger fires? Is there a catch-up scan on restart, or is the action silently skipped?

**New external dependency** — What is the failure mode when the dependency is unavailable (transient vs. extended)? Does the calling code retry? Does it degrade gracefully or freeze?

**New file or volume write** — Can the volume fill up? Is there any monitoring or alerting? What happens to the mission if writes start failing?

**New in-process computation or tool call** — Can it hang indefinitely? Is it guarded by a timeout and AbortSignal? Is the timeout surfaced to the operator?

**Operational resilience is never optional.** When a new component reaches production, its failure mode must be documented in `docs/operational-resilience.md` before the sprint closes.

See `docs/operational-resilience.md` for the full FMEA analysis and gap backlog. Use `/operational-resilience` to review and update the document after a sprint.
