---
name: inter-agent-comms
description: |
  PostMessage conventions for structured inter-agent communication.
  Use when drafting a message to a peer agent or supervisor.
---

# Inter-Agent Communication Conventions

## Subject line format

`[intent] Brief description of the ask or result`

**Intent tags:**
- `[task]` — requesting another agent perform a task
- `[result]` — reporting the outcome of a completed task
- `[question]` — asking for clarification or data
- `[alert]` — urgent issue requiring immediate attention
- `[fyi]` — informational, no action required

**Examples:**
- `[task] Analyse Q4 earnings PDF and report key figures`
- `[result] Report complete — saved at /missions/x/shared/report.md`
- `[alert] Source feed unreachable since 06:15 UTC`

## Message body

For **task requests**, include:
- Clear success criteria ("I need you to return X")
- Relevant file paths or artifact references
- Deadline or priority if time-sensitive

For **result submissions**, include:
- A one-line summary of the outcome
- Absolute path(s) of any output files written
- Any caveats or follow-up actions needed

## Artifact references

When referring to a file you have written:
- Use the absolute path: `/missions/{id}/shared/report.md`
- State the commit SHA if committed: `(commit abc1234)`

## Priority

Use PostMessage priority sparingly:
- `normal` (default) — teammate processes on their next turn
- `high` — teammate should prioritise this over other pending mail

Reserve `high` for genuine blockers or time-critical information.
