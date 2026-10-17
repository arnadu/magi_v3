---
name: schedule-management
description: |
  Managing scheduled agent wakeups: cron syntax, ListSchedule/create_schedule/
  cancel_schedule workflows, common patterns, and the missed-fire limitation.
---

# Schedule Management

## How scheduled wakeups work

Scheduled messages live in the `scheduled_messages` MongoDB collection. The **control plane's**
scheduler tick (every minute) claims entries with `deliverAt <= now` and `status: "pending"`,
wakes the mission's machine if it is stopped, posts the message into the recipients' mailboxes
and marks the entry `delivered` — or, for a `cron` entry, re-arms it with the next `deliverAt`.

Each entry has:
- `missionId` — which mission
- `to` — recipient agent ids (and/or `"user"` for the operator)
- `subject`, `body` — the mailbox message that is delivered
- `cron` — optional 5-field cron (UTC) for a recurring wakeup; the entry re-arms after each fire
- `deliverAt` — the next delivery time (computed from `cron`, or given directly for a one-off)
- `label` — optional short name shown in listings
- `status` — `pending` | `delivered` | `cancelled` | `failed`

## Listing schedules

Call the `ListSchedule` tool:
```json
{ "missionId": "gold-digest-001" }
```
Omit `missionId` to list every schedule across your missions. Each row shows the entry's id
(a 24-hex MongoDB id) — that is what `cancel_schedule` takes.

## Creating a schedule

Use `ProposeAction` with type `create_schedule`. The payload is validated strictly: exactly
these keys, `to` is a list, and one of `cron` / `deliverAt` is required (a schedule with
neither would be delivered immediately). The card the operator confirms shows the full payload.

```json
{
  "type": "create_schedule",
  "payload": {
    "missionId": "gold-digest-001",
    "to": ["lead-analyst"],
    "subject": "Daily gold market brief",
    "body": "Good morning. Please produce today's gold market brief and post it to the operator when complete.",
    "cron": "30 8 * * 1-5",
    "label": "Daily brief — 08:30 UTC weekdays"
  }
}
```

A one-off wakeup uses `deliverAt` (ISO-8601, UTC) instead of `cron`:

```json
{
  "type": "create_schedule",
  "payload": {
    "missionId": "gold-digest-001",
    "to": ["lead-analyst", "user"],
    "subject": "FOMC decision follow-up",
    "body": "The FOMC statement is out — summarise the gold reaction in the next hour.",
    "deliverAt": "2026-11-05T19:30:00Z"
  }
}
```

Recipients must be agents of that mission (or `"user"`); the action is refused otherwise.

## Cancelling a schedule

Use `ProposeAction` with type `cancel_schedule`, with the 24-hex id from `ListSchedule`:

```json
{
  "type": "cancel_schedule",
  "payload": {
    "id": "6710a1b2c3d4e5f60718293a"
  }
}
```
Cancelling an entry that is no longer `pending` (already delivered, or cancelled) is reported
as a failure, not a success.

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

## Timing guarantees and their limits

The control plane keeps time, so a schedule fires even while the mission's machine is stopped:
the scheduler wakes the machine and the agent finds the message on its first turn. What the
scheduler cannot do:

- **Fire while the control plane itself is down.** A missed `deliverAt` is delivered on the
  first tick after the control plane is back (late, not skipped); a `cron` entry then re-arms
  from that point, so one occurrence may be delivered late and none are duplicated.
- **Fire more precisely than the minute tick.** Expect up to ~60 s of jitter, plus machine
  start time (~30–60 s) if the mission was stopped.

Tell the operator both limits when setting up anything deadline-sensitive.

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
