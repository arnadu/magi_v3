---
name: vm-upgrade-oversight
description: |
  Reviewing machine-upgrade activity: judge whether a mission holds a bigger
  machine than it needs, handle cap-near and cap-reached, and recognise when
  the default machine size should change.
---

# VM upgrade oversight

Covers everything ADR-0031's temporary machine upgrades surface to you:
`oom-suspected`, `upgrade-cap-near`, `upgrade-cap-reached`, `upgrade-idle`, and
the daily report's "Chronic upgrade" flag. `GetMissionStatus` shows a
mission's current tier, time on it, and cumulative upgraded runtime used
against the 24h cap whenever you need current numbers outside of an alert.

## `oom-suspected` (or a `job-failure` with exit 137/-9)

A machine exit consistent with an out-of-memory kill — inferred from the exit
signal, not certain (hence "suspected"; see `incident-triage` for what the
signal actually means). Either signature usually means the mission's current
machine is too small for what it's trying to do right now.

- If the mission is **not already at the maximum shape** (4 CPUs / 16 GB —
  `RequestResourceUpgrade`'s own menu shows the ceiling), propose a message to
  the mission's own copilot suggesting it request a temporary upgrade
  (`RequestResourceUpgrade`) sized for the task that failed. You can't call
  that tool yourself — it's the mission copilot's, scoped to its own mission.
- If it **already ran at the maximum shape** and still hit this, the job
  itself needs redesigning (chunking the work, streaming instead of loading
  everything into memory) — a bigger machine isn't available as the fix.
  Say so plainly rather than suggesting a re-request that can't help.

## `upgrade-idle`

An upgraded machine with no conversation activity and no running background
job for 30+ minutes — the upgrade is probably no longer needed. Propose a
message to the mission's own copilot asking whether the job that justified the
upgrade has finished; if so, it should let the upgrade lapse (or call
`EndResourceUpgrade`) rather than let it run — and keep costing more — until
expiry. Don't assume the answer is "let it lapse" yourself; the mission's own
copilot has the context (what the job actually was) that you don't.

## `upgrade-cap-near`

At or above 80% of the mission's 24h cumulative upgraded-runtime cap since its
last operator reset. Check the pattern behind it: a single long job that
legitimately needed the time is different from many short upgrades adding up
(which usually means the *default* machine is undersized — see "Chronic
upgrade" below). Surface the distinction to the operator rather than treating
every cap-near the same way.

## `upgrade-cap-reached`

A `RequestResourceUpgrade` call was rejected because the cap was already hit.
This is hard-relayed to you automatically. There is nothing you can do about
it yourself — only the operator can reset the cap, in the cockpit's Limits
panel. Tell them the mission id and that a request was rejected; don't
speculate about working around it.

## Chronic upgrade (daily report flag)

Upgraded on 5 or more of the last 7 daily snapshots — a mission that's
effectively always running upgraded is a sign its *default* machine is sized
wrong, not that it keeps needing one-off upgrades. Once the mission is
suspended (required before any config edit), propose `save_session_config`
raising `mission.memoryMb`/`cpus` to match what it's actually been running at,
rather than letting it keep paying the upgrade-request overhead indefinitely.
Confirm with the operator before suspending a running mission just to make
this change — it's a real interruption, not something to do silently.
