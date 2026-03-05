---
name: schedule-task
description: Register a recurring scheduled message to trigger timed agent wakeups. Use to set up the daily 06:00 cycle or any recurring task.
scope: platform
---

# Schedule Task

## Purpose

Writes a JSON schedule file to `sharedDir/schedules/<label>.json`.
The daemon picks this up on its next heartbeat and registers the entry in the
`scheduled_messages` collection. Messages are then delivered on the cron schedule
and the entry is automatically re-armed after each delivery.

Re-running the script with the same label updates the schedule (safe to call multiple times).

## Usage

```bash
bash <platform-skills-path>/schedule-task/scripts/schedule.sh \
  "<label>" \
  "<comma-separated-agent-ids>" \
  "<cron-expression>" \
  "<subject>" \
  "<body>"
```

### Arguments

| Argument | Description | Example |
|----------|-------------|---------|
| `label`  | Unique name for this schedule. Re-using overwrites. | `daily-brief` |
| `to`     | Comma-separated recipient agent ids | `lead-analyst` |
| `cron`   | Standard 5-field cron expression | `0 6 * * 1-5` |
| `subject`| Message subject line | `[task] Daily cycle — begin` |
| `body`   | Message body | `Begin the daily research cycle...` |

### Common cron patterns

| Pattern | Meaning |
|---------|---------|
| `0 6 * * 1-5` | Mon–Fri at 06:00 |
| `0 6 * * *`   | Every day at 06:00 |
| `0 9 * * 1`   | Every Monday at 09:00 |
| `0 */4 * * *` | Every 4 hours |

## Example — daily 06:00 research cycle

```bash
bash <platform-skills-path>/schedule-task/scripts/schedule.sh \
  "daily-brief" \
  "lead-analyst" \
  "0 6 * * 1-5" \
  "[task] Daily cycle — begin" \
  "The daily research cycle begins now. Task your team (economist, junior-analyst, data-scientist), synthesise their research, and publish the morning brief."
```

## Output

The script writes `sharedDir/schedules/<label>.json` and prints confirmation.
The daemon will import it on its next heartbeat (within 1 minute) and log:

```
[daemon:scheduler] Schedule imported: daily-brief → next at 2026-03-06T06:00:00.000Z
```

## Cancelling a schedule

To cancel a schedule, delete the JSON file:
```bash
rm <sharedDir>/schedules/<label>.json
```

Note: an already-pending entry in the database will still fire once. To also cancel the pending delivery, you would need operator intervention via `cli:post` or direct database access.
