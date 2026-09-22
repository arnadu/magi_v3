---
name: disk-pressure
description: |
  Responding to a mission volume filling up: find what is growing, then
  choose cleanup, extending the volume, or suspending before writes fail.
---

# Disk pressure

Triggered by a `disk-usage-high` anomaly (soft at 80%, hard at 90% of the Fly
Volume) or a "Disk" flag in the daily report. `GetMissionStatus` shows the
latest sample and its age if you need current numbers outside of an alert.

## Read the breakdown first

The 90% (hard) alert's mailbox body carries the top-5 directories by size, from
a bounded `du` the sampler runs once when crossing that threshold — this is
your starting point, not something you need to go re-derive. A soft (80%)
alert has no breakdown; if you need one, wait for the next sample to cross
hard, or ask that mission's own copilot (it has direct filesystem tools you
don't) to check `du -sh` on its own workspace.

## Choose a response by what's growing

- **Logs or temp files** — propose `create_schedule` addressed to the
  mission's own copilot, asking it to prune the specific paths. You don't have
  filesystem write access to a mission's volume; the mission's own copilot
  does.
- **Git objects** (a mission workspace with `.git` history that's never been
  compacted) — same route: ask the mission's copilot to run `git gc` in the
  relevant workspace.
- **Genuine agent-authored data growth** (real output the mission is
  producing, not logs or repo bloat) — this isn't a cleanup problem. Fly
  volumes can grow but not shrink, and there is currently no `ProposeAction`
  type for it — extending one is a manual `flyctl volumes extend` step only
  the operator can run. Tell the operator the current usage, the growth rate
  if the alert or daily report included one, and that the volume needs
  extending; don't propose an action type that doesn't exist.
- **≥ 95% usage, or the daily report's growth-rate projection puts it full
  within 2 hours** — propose `suspend_mission` before it hits 100% and writes
  start failing outright. This is worth doing even before you've identified
  the cause; a full volume is a much worse failure mode than a paused mission,
  and the mission can resume once the operator has extended the volume or
  agreed to a cleanup.

## After acting

If you asked the mission's copilot to clean something up, don't consider the
flag resolved until the next sample confirms the usage actually dropped — a
prune that didn't touch the actual growth driver (wrong directory, a process
still writing to the file you deleted) looks identical to "done" until you
check. Note the outcome in your mental map's Resource oversight table either
way.
