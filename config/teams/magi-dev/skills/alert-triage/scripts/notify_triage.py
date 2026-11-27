#!/usr/bin/env python3
"""notify_triage.py — after a triage run, mail the agent only when there is work for it.

    notify_triage.py <state-dir> <agent-id>

Reads the newest run's summary in <state-dir>/runs/. Mails <agent-id> (through the Tool API, as
the job's own agent) when the run has a finding to verify, or an item that failed, was rejected or
came back incomplete; otherwise once a UTC day with the backlog line. Silent the rest of the time,
so an hourly run does not wake the agent every hour. The mail holds counts and item ids, never an
alert's content (the alerts are private).
"""
import json
import os
import sys
import time

TROUBLE = ("failed", "rejected", "incomplete")


def newest_run(state_dir):
    runs_dir = os.path.join(state_dir, "runs")
    runs = sorted(os.listdir(runs_dir)) if os.path.isdir(runs_dir) else []
    if not runs:
        return None, None
    with open(os.path.join(runs_dir, runs[-1], "summary.json"), encoding="utf-8") as f:
        return runs[-1], json.load(f)


def backlog_line(summary):
    b = summary.get("backlog", {})
    bands = ", ".join(f"{n} {band}" for band, n in sorted(b.get("byBand", {}).items()))
    budget = b.get("dayBudgetUsd")
    spent = f"${b.get('spentTodayUsd', 0)} spent today" + (f" of ${budget}" if budget else "")
    oldest = b.get("oldestWaitingSince")
    return (f"Backlog: {b.get('left', 0)} left" + (f" ({bands})" if bands else "")
            + (f", oldest waiting since {oldest}" if oldest else "") + f"; {spent}.")


def decide(stamp, summary, today, last_daily):
    """(subject, body, is_daily) for the mail to send, or None to stay silent."""
    counts = summary.get("counts", {})
    trouble = {k: counts[k] for k in TROUBLE if counts.get(k)}
    findings = summary.get("findings", 0)
    lines = [f"Run {stamp} at commit {summary.get('commit', '?')[:12]}: {json.dumps(counts)}.",
             backlog_line(summary),
             "Follow skill alert-triage, 'After a run'."]
    if findings:
        return f"Alert triage: {findings} finding(s) to verify", "\n".join(lines), False
    if trouble:
        what = ", ".join(f"{n} {k}" for k, n in trouble.items())
        return f"Alert triage: {what}", "\n".join(lines), False
    if last_daily != today:
        return "Alert triage: daily backlog", "\n".join(lines), True
    return None


def main(argv):
    state_dir, agent = argv[0], argv[1]
    stamp, summary = newest_run(state_dir)
    if summary is None:
        return 0
    marker = os.path.join(state_dir, "last-daily-note")
    try:
        with open(marker, encoding="utf-8") as f:
            last_daily = f.read().strip()
    except OSError:
        last_daily = ""
    today = time.strftime("%Y-%m-%d", time.gmtime())
    mail = decide(stamp, summary, today, last_daily)
    if mail is None:
        return 0
    subject, body, _ = mail
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, os.path.join(here, "..", "..", "..", "_platform", "run-background", "scripts"))
    import magi_tool  # noqa: E402 — only when run as a real job

    magi_tool.post_message(agent, subject, body)
    # Any mail carries the backlog line, so it counts as the day's note.
    with open(marker, "w", encoding="utf-8") as f:
        f.write(today)
    print(json.dumps({"notified": agent, "subject": subject}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
