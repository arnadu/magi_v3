---
name: incident-triage
description: |
  How to investigate each category of system-generated anomaly (limit
  breaches, agent crashes/timeouts, LLM errors, failed background jobs,
  failed scheduled deliveries, unclean restarts, mission resume failures,
  and the resource-oversight categories — disk, spend, machine upgrades,
  OOM) — what to check first, and which action tier it falls into. Shared by
  the mission copilot and the control-plane copilot; each has a different
  vantage point on the same categories, noted per section below.
---

# Incident triage

## How an anomaly reaches you

A system-generated anomaly arrives as a mailbox message from `"system"`, subject
`Anomaly ({severity}): {category}`. The same event is also persisted to the
`missionAnomalies` collection — you don't need to query it directly for a single
incident (the mailbox message already has what you need), but it's the source
for the cockpit Trace panel's markers and useful if you want the full history for
a mission, not just the one that just woke you.

Two audiences read this skill:

- **Mission copilot**: you get every anomaly for your own mission, both `soft`
  and `hard` severity. You have direct diagnostic tools (below) — use them.
- **Control-plane copilot**: you only receive `hard`-severity anomalies,
  relayed from whichever mission hit one. Your own tools here are coarse
  (`ReadMissionMailbox`, `ReadMissionLog`, `ReadMissionFile`) — per your own
  system prompt, this is a top-level check, not a diagnosis tool. Your real
  value is noticing a *pattern across missions* (the same category recurring
  in several missions in a short window usually means a platform-level
  problem, not a mission-level one) — point the operator at the specific
  mission's own copilot for actual diagnosis, don't try to do its job from
  the outside.

After you've looked into one, decide whether it's genuinely new or a recognized recurring
pattern you've already diagnosed:

- **Genuinely new or actionable** — append a new paragraph to your mental map's `#anomaly-log`
  section: category, what you found, what you did.
- **A recognized recurring benign pattern** (same category/cause combination you've already
  diagnosed, still needing no action) — update that pattern's existing counter line in place
  ("brave-429 tool errors: 18 occurrences to date, all benign, last seen Aug 23") instead of
  adding a fresh paragraph. Dozens of near-identical paragraphs restating "same as before, no
  action needed" is a sign the log stopped being useful and started costing your own context on
  every future turn for no decision-relevant benefit — collapse it into a counter before it gets
  there, not after.

See `mission-leadership`'s (or `magi-template-design`'s) "which surface" guidance for why the
mental map (not this skill) is the right place for this record.

## Categories

### `limit-breach`

A `LimitRule` was exceeded — cost, LLM-call count, context size, tool-error
rate, or a streak of zero-output turns. The mailbox message already names the
metric, value, and threshold.

- **Investigate**: `ReadAgentUsage` for the agent's recent cost/token trend
  first (cheap, summary-level) — is this a one-off spike or a sustained
  climb? If it looks like a genuine problem, `ReadAgentSessionDetail` on the
  specific turn named in the alert to see what it was actually doing.
- **Action tier**: a single soft breach is often nothing — note it and move
  on. A hard breach already aborted the turn; the question is whether the
  underlying cause (a stuck loop, an oversized tool result, a genuinely
  larger task than expected) needs a config change. That's a team/config
  change tier — smallest edit, then tell the user.

### `agent-crash`

The agent's whole dispatch failed with an uncaught exception (not an LLM
error — see `llm-error` below).

- **Investigate**: `ReadAgentSessionDetail` for the turn named in the alert —
  what was the last tool call before the crash? `ReadMissionLog` for the raw
  daemon log around that timestamp often has the actual stack trace/error
  text the mailbox summary doesn't include.
- **Action tier**: usually ambiguous/irreversible until you know the cause —
  post to the user once you've identified what broke, rather than guessing
  at a fix. If it's clearly a bad tool call the agent made (not a platform
  bug), a supervisor note or objective correction may be enough on its own.

### `agent-timeout`

The agent exceeded its wall-clock dispatch limit and was aborted — a
"runaway agent" or "doom loop" symptom.

- **Investigate**: `ReadAgentSessionDetail` on the aborted turn — look for a
  repeating tool-call pattern (the actual doom-loop signature) versus a
  single long-running call (e.g. a big `BrowseWeb` task that's just slow).
  If it was waiting on a background job, `ListBackgroundJobs` shows whether
  the job itself is stuck.
- **Action tier**: a genuine loop is worth a supervisor note or a prompt
  correction (team/config tier). A single slow-but-legitimate task usually
  needs no action — don't over-correct a one-off into a permanent prompt
  change.

### `llm-error`

A single LLM completion call returned an error stop reason.

- **`soft` (transient — overloaded/rate-limited)**: these self-resolve; the
  SDK already retries internally before this even fires. `ReadAgentUsage` to
  check whether it's a one-off or recurring — recurring transient errors on
  the same agent are worth a note, but rarely need action from you.
- **`hard` (non-transient — auth/credits)**: this needs the operator, not
  you — you can't fix an expired API key or exhausted credit balance.
  Post to the user promptly rather than investigating further; there's
  nothing more to diagnose on the mission side.

### `job-failure`

A background job crashed the mission process enough times to be permanently
failed out (not retried again).

- **Investigate**: `ListBackgroundJobs` for status, then `ReadSharedFile` on
  the failed job's spec (`jobs/failed/<file>`) and status record
  (`jobs/status/<id>.json`) — the error field states why it stopped being
  retried. This usually means the job itself is the cause (e.g. it exhausts
  machine memory), not an unrelated crash.
- **Action tier**: don't `RestartBackgroundJob` until you understand what the
  job was doing when it crashed the machine — blindly retrying reproduces
  the same crash. If the job's own logic is the problem, that's a mission
  skill/script fix, not something to route through a mailbox note.

### `scheduling-failure`

A scheduled message failed to deliver enough times in a row that it was
marked `failed` and given up on (not retried further).

- **Investigate**: `ListScheduledMessages` to confirm the schedule is really
  gone (not just delayed) — was this a one-off you created with
  `CreateScheduledMessage`, or a recurring cadence (like your own alignment
  review) that just went silent?
- **Action tier**: if it was your own recurring check-in, re-create it with
  `CreateScheduledMessage` — don't just note the gap and move on, since
  nothing else will re-arm it for you. If it was a teammate's schedule,
  a supervisor note pointing at the gap is usually enough for them to
  re-create it themselves.

### `unclean-restart`

The daemon started up after a prior run that never reached graceful
shutdown (a stale PID, no matching live process).

- **Investigate**: this signal can't identify *why* the process died — it
  could be an unrelated platform restart, or a genuine OOM/crash. Check
  `ReadMissionLog` around the restart timestamp for anything unusual in the
  turns immediately before it. A single occurrence with no other evidence of
  a problem generally isn't worth chasing further.
- **Action tier**: mostly informational — log it in your anomaly log. If it
  recurs for the same mission, that pattern (not any single instance) is the
  real signal something's wrong, and is worth raising to the user.

### `disk-usage-high` (ADR-0032)

The mission's Fly Volume is at 80% (soft) or 90% (hard, with a top-5
directories breakdown in the message body).

- **Mission copilot**: the breakdown tells you what's growing. Clean up logs
  or temp files directly, `git gc` a bloated `.git`, or tell the user the
  volume needs extending (Fly volumes only grow, never shrink — no tool of
  yours does this).
- **Control-plane copilot**: see the `disk-pressure` skill.

### `spend-cap-near` (ADR-0032)

90% (soft) or 98% (hard) of the mission's spend cap (`mission.maxCostUsd`).

- **Mission copilot**: `ReadAgentUsage` per agent to find the driver;
  `PauseAgent` on a runaway, or `SetMissionSpendCap` to raise the cap if the
  spend is legitimate (within whatever ceiling the operator allows).
- **Control-plane copilot**: see the `cost-management` skill.

### `spend-spike` (ADR-0032)

Soft only: 24h spend over 3x the trailing 7-day daily average, and over $5.
Informational, not a cap breach — investigate the same way as a burn-rate
spike (see `cost-management` for the control-plane copilot; `ReadAgentUsage`
for the mission copilot), decide if it's an expected bigger day or worth a
note.

### `upgrade-cap-near` / `upgrade-cap-reached` (ADR-0031/0032)

80% of the mission's 24h cumulative upgraded-runtime cap (soft), or a rejected
`RequestResourceUpgrade` call because the cap was already hit (hard).

- **Mission copilot**: for cap-near, judge whether the current upgrade still
  needs the remaining time. For cap-reached, there is nothing you can do —
  only the operator can reset the cap (cockpit Limits panel); say so.
- **Control-plane copilot**: see the `vm-upgrade-oversight` skill.

### `upgrade-idle` (ADR-0032)

The mission is on an upgraded machine with no conversation activity and no
running background job for 30+ minutes.

- **Mission copilot**: check whether the job that justified the upgrade has
  actually finished; if so, `EndResourceUpgrade` rather than let it run to
  expiry.
- **Control-plane copilot**: see the `vm-upgrade-oversight` skill.

### `resize-failure` (ADR-0031)

A temporary upgrade's machine resize failed partway — see `mission-recovery`'s
own dedicated failure-mode entry for the recovery sequence (both copilots use
the same one: propose/perform `resume_mission`).

### `resume-failure` (control-plane mission lifecycle, issue #62)

A plain operator- or copilot-initiated `resume_mission`/`POST /:id/resume`
failed, for any reason — most commonly `mission.volumeId` in MongoDB having
drifted to a volume that no longer exists on Fly (not data loss — the real
volume is untouched, just no longer what the record points at). Distinct
from `resize-failure` above: that's specifically ADR-0031's upgrade/revert
path; this covers a plain resume failing for any cause, including ones not
yet seen.

- **Control-plane copilot**: this is the audience that actually acts on it —
  see `mission-recovery`'s dedicated failure-mode entry for the full
  diagnostic sequence and the `fix_mission_volume` → `resume_mission`
  recovery pair.
- **Mission copilot**: you should never see this — `/resume` is an
  operator/control-plane-copilot-driven route, not something your own tools
  call. If you somehow do (e.g. a relayed message reaching you by mistake),
  there is nothing actionable on the mission side; point the operator at the
  control-plane copilot instead of investigating locally.

### `oom-suspected` (ADR-0032)

An unrequested machine exit consistent with an out-of-memory kill (inferred
from the exit signal — "suspected," not certain). A killed *child* process
(e.g. a Python background job) surfaces differently, as a `job-failure` with
exit code 137/−9 — treat that the same way.

- **Mission copilot**: if not already on the maximum shape, consider
  `RequestResourceUpgrade` sized for the task that failed. If it already ran
  at the maximum shape, the job itself needs redesigning — a bigger machine
  isn't available as the fix.
- **Control-plane copilot**: see the `vm-upgrade-oversight` skill.

## Worked example: don't let a plausible story substitute for evidence

A mission copilot once reported "agents were overwriting each other's
objectives" and applied a mitigation based on that read — plausible, and
wrong. The actual cause only surfaced from direct evidence: the turn git
blame pointed at was checked and had *zero tool calls* that turn (ruling out
that agent as the writer), and the git diff shape was a wholesale content
revert, not a targeted field edit (ruling out a normal overwrite). The real
cause was a workspace-provisioning step silently reverting a file from a
stale snapshot on every resume — nothing to do with any agent's behavior at
all. The lesson generalizes to every category above: a mailbox alert tells
you *that* something happened, never *why* — open the actual turn detail,
the actual log, the actual diff, before you write down a cause.
