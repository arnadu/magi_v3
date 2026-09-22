---
name: request-resources
description: |
  Ask for, and (for the mission-copilot) grant, a temporary bigger machine
  for a genuine compute burst — memory-heavy data loads, big numerical jobs,
  anything that risks running out of RAM on the default 1 GB machine. Read
  this before submitting known-heavy work, and before deciding whether to
  grant or renew someone else's request.
scope: platform
---

# Request Resources

This mission's machine is cheap and small by default (shared, 1 CPU, 1 GB RAM) so
idle time doesn't cost anything. When a job genuinely needs more, any agent can ask
for a temporary upgrade — but only the mission-copilot can actually grant one, because
granting one **hard-suspends and re-creates the machine**: every other agent's current
turn is aborted and every running background job is re-run from scratch. The
mission-copilot is in the best position to judge whether that's safe right now,
because it can see what the rest of the team is doing and a single requesting agent
can't.

This skill is the single source of truth for both sides of that request — read the
section for your role.

## If you are a worker agent: how to ask

**When to ask.** Ask *before* starting known-heavy work, not mid-crash. Signs you need
it:
- The data you're about to load is larger than roughly half the machine's current RAM.
- A previous attempt at this job was killed or errored out of memory.
- The job is expected to run for hours (sustained CPU, not just a burst).

Don't ask for a routine job that already fits comfortably on the default machine.
Check current memory with `free -m` before guessing.

**What to ask for.** Pick the *cheapest* shape that fits, from the menu below or
off-menu if nothing fits. RAM is usually the actual constraint, so prefer `shared`
with more RAM for memory-heavy, CPU-light work (loading a big dataframe, a Jupyter
notebook, most data processing). Choose `performance` only for sustained CPU-bound
work (model training, heavy numerical computation) — `shared` CPUs are throttled to a
small baseline and will not speed up compute-bound work. Leave about 25% RAM headroom
over your estimated peak. Duration is required — there is no default — and capped at
60 minutes per window; ask for the shortest window that covers the work plus a margin,
and plan to renew if the job runs long.

**The menu** (approximate cost; regenerated from the maintained price table — never
hand-edit these numbers):

| Shape | kind | CPUs | RAM | ≈ $/h |
|---|---|---|---|---|
| default (today) | shared | 1 | 1 GB | 0.008 |
| memory, small | shared | 1 | 2 GB | 0.015 |
| memory, medium | shared | 2 | 4 GB | 0.03 |
| memory, large | shared | 4 | 8 GB | 0.06 |
| compute, small | performance | 1 | 4 GB | 0.06 |
| compute, medium | performance | 2 | 8 GB | 0.12 |
| compute, large | performance | 4 | 16 GB | 0.24 |

Off-menu shapes are fine as long as they're within Fly's valid combinations and the
platform's maximum size (4 CPUs / 16 GB) — the menu is guidance, not an enforced list.

**The message.** Send a `PostMessage` to `mission-copilot` stating, in one line each:
the shape you want (kind, CPUs, RAM), the duration, what job needs it, and why that
size — exactly what the copilot needs to decide without asking a follow-up question.
For example:

```
PostMessage(to: ["mission-copilot"], subject: "Resource upgrade request",
  body: "Requesting shared, 2 CPUs, 4 GB for 30 min: loading a 3 GB parquet file for the
  weekly cohort analysis. Current machine only has 1 GB.")
```

**What happens next.** If the copilot agrees, the machine is hard-suspended and
re-created on the bigger shape: your current turn (and everyone else's) is aborted, and
any running background job is re-run from scratch on restart. Wait for the copilot's
reply before starting the heavy job, and be prepared for it to say "wait" (something
else is mid-task) or "no" (the size doesn't match the job, or a smaller shape would do).

**At expiry.** You'll get a reminder about 10 minutes before the window ends, addressed
to both you and the mission-copilot. Reply whether you still need it and for how long —
if the job is done, say so, so the machine can revert on schedule instead of being
renewed out of habit.

**No mission-copilot on this mission** (`MISSION_COPILOT_ENABLED=false`): ask the user
directly instead — there's no one else who can grant this.

## If you are the mission-copilot: how to decide

**Deciding.** Before acting on a request, check who else is mid-task — `ListTeam`,
`ReadMissionLog`, `ListBackgroundJobs` — since granting it interrupts everyone, not just
the requester. Your options are: act now; ask the requester (and anyone else affected)
to wrap up or reach a checkpoint first; ask the requester to wait; or decline, or
propose a smaller shape, if the stated job doesn't actually need what was asked for. An
oversized request costs real money for no benefit — sanity-check the size against the
job before granting it.

**Acting.** Call `RequestResourceUpgrade` with `requestedByAgentId` set to whoever
asked, then tell the requester and anyone whose turn was interrupted what happened and
when the machine reverts. A rejected shape comes back with the list of valid options —
correct and retry once with a valid shape; don't loop on repeated rejections.

**Renewing.** When the pre-expiry reminder arrives, consult the requester via
`PostMessage` before deciding, rather than renewing unilaterally — they're the one who
knows whether the job actually finished. Renew only if the work is still running. A
same-shape renewal just extends the expiry with no restart; don't let renewals become
the default way this mission operates — if a job keeps needing the same upgrade, that's
a signal the mission's default machine size should change (`SaveMissionConfig`), not
that it should stay perpetually upgraded.

**Ending early.** If the requester reports the job is done before the window expires,
call `EndResourceUpgrade` to return to the default machine and stop paying for the
bigger one — don't wait out the timer if nothing needs it anymore.
