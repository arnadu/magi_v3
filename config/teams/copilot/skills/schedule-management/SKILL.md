---
name: schedule-management
description: |
  Managing scheduled agent wakeups: cron syntax, ListSchedule/create_schedule/
  cancel_schedule workflows, common patterns, and the missed-fire limitation.
---

# Schedule Management

## How scheduled wakeups work

Scheduled messages live in the `scheduled_messages` MongoDB collection. The daemon's
cron heartbeat (every minute) scans for entries with `fireAt <= now` and `status: "pending"`,
then delivers them to the target agent's mailbox and marks them `delivered`.

Each schedule entry has:
- `missionId` — which mission
- `agentId` — which agent receives the message
- `cronExpression` — when to fire (standard 5-field cron, UTC)
- `message` — the message content delivered to the agent
- `status` — `pending` | `delivered` | `cancelled`
- `fireAt` — next computed fire time

## Listing schedules

```json
{ "type": "list_schedule", "missionId": "gold-digest-001" }
```
Omit `missionId` to list all schedules across all missions.

## Creating a schedule

Use `ProposeAction` with type `create_schedule`:

```json
{
  "type": "create_schedule",
  "label": "Daily brief — 08:30 UTC weekdays",
  "payload": {
    "missionId": "gold-digest-001",
    "agentId": "lead-analyst",
    "cronExpression": "30 8 * * 1-5",
    "message": "Good morning. Please produce today's gold market brief and post it to the operator when complete."
  }
}
```

## Cancelling a schedule

Use `ProposeAction` with type `cancel_schedule`:

```json
{
  "type": "cancel_schedule",
  "label": "Cancel daily brief schedule",
  "payload": {
    "scheduleId": "<MongoDB _id of the schedule entry>"
  }
}
```
Get the `scheduleId` from `ListSchedule` output.

## Cron expression reference (UTC, 5-field)

```
┌── minute (0–59)
│  ┌── hour (0–23)
│  │  ┌── day of month (1–31)
│  │  │  ┌── month (1–12)
│  │  │  │  ┌── day of week (0–7, 0=Sun, 7=Sun)
│  │  │  │  │
*  *  *  *  *
```

Common patterns:

| Expression | Meaning |
|-----------|---------|
| `30 8 * * 1-5` | 08:30 UTC Monday–Friday |
| `0 9 * * 1` | 09:00 UTC every Monday |
| `0 */4 * * *` | Every 4 hours |
| `0 9,17 * * 1-5` | 09:00 and 17:00 UTC weekdays |
| `0 0 1 * *` | Midnight on the 1st of each month |
| `*/30 9-17 * * 1-5` | Every 30 min during market hours (UTC) |

## Important limitation — missed fires (G-3 gap)

**The daemon does NOT replay missed fires on restart.** If the execution plane machine
is down when a cron expression fires, that fire is silently skipped. There is no
catch-up scan on startup.

Implications:
- Do not rely on scheduled tasks for hard-deadline critical actions
- After a machine restart, check `ListSchedule` — if a fire was missed, manually post
  the message to trigger the task
- Inform the operator of this limitation when setting up time-sensitive schedules

This is a known gap (G-3) on the backlog; it has not been fixed yet.

## Typical schedule patterns by mission type

**Daily equity brief (market days only):**
```
30 8 * * 1-5  — trigger lead analyst to produce brief before US market open
```

**Weekly sector report:**
```
0 7 * * 1  — trigger on Monday morning UTC
```

**Continuous monitoring (e.g. alerts):**
```
0 * * * *  — hourly check; agent decides if anything is worth reporting
```

**Post-market summary:**
```
0 21 * * 1-5  — 21:00 UTC = ~4 PM US Eastern after close
```
