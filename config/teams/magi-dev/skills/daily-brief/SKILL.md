---
name: daily-brief
description: The user's daily brief from MAGI DEV, built by a script from the mission's records (major issues found, issues verified resolved, the backlog by priority with ages) and sent at 18:00 New York time. For the mission copilot - schedule it once, read a failed run, never write the brief yourself.
---

# Daily brief

Once a day a background job sends the user one message, built by code from the team's records:

- **Major issues discovered** since the last brief: new entries of the security register, any
  severity; the blocking code-review findings and the wrong documentation statements named in
  each new report's `**Findings:**` line. A report rejected by the citation gate is marked so.
- **Verified resolved**: register entries that reached `fixed, verified` since the last brief.
- **Backlog**: the open register entries by severity, with the oldest's age; the pipeline's
  leads waiting for appsec's verification and the alerts not yet triaged, by band, with the
  oldest's age (from `status/alert-triage.json`, which each triage run publishes); each
  reviewer's cursor against the reference copy; the citation gate's verdict on each new report.

No model writes any of it, so nothing in it can be invented; a gap shows as a gap ("no
Findings line", "no status published", a stale triage status).

## Schedule it (once, as the mission copilot)

```bash
bash "$SHARED_DIR/skills/_platform/run-background/scripts/schedule-job.sh" --label daily-brief \
  --cron '0 22,23 * * *' --script "$SHARED_DIR/skills/_team/daily-brief/scripts/daily_brief.py" \
  --args "$SHARED_DIR $WORKDIR"
```

The schedule is in UTC and fires at the two hours that can be 18:00 in New York; the script
sends at the first run at or after 18:00 New York time and stays silent at the other, so the
brief arrives at 18:00 in winter and in summer. Its defaults are `--tz America/New_York --at
18:00 --to user`; change them only when the user asks. What the last brief saw is in
`$WORKDIR/daily-brief/state.json`: never edit it, or the next brief's "since the last brief"
is wrong.

## When a run fails

The platform tells you. Report the last lines of its log to the user and leave the next run to
the schedule. Do not send a brief of your own instead: the user relies on it being built from
the records. To see what the next brief would say without sending it, run the script with
`--dry-run`.
