# ADR-0040: Work queues — a to-do list, a priority, a daily budget, and a report of what is left

**Status:** Accepted (2026-11-27).
**Relates to:** ADR-0039 (sub-agents bounded by time, turns and now money), the review pipeline
(`packages/skills/review-pipeline`), MAGI DEV's alert triage. Plan and the survey of existing
loops: [docs/plans/work-queues.md](../plans/work-queues.md).

## Context

MAGI DEV's alert triage cleared its backlog at an accidental pace (one run a day, as much as fit
in 12 minutes), in the order its producer happened to list the alerts, with no figure for how far
behind it was. When the pace looked wrong, the agents changed the job's arguments by guesswork.
The same loop shape (gather by code, process items with an LLM, consolidate for an agent) exists
in the data factory's news digests and, without the LLM step, in the report gate.

## Decision

A loop over many items is a **work queue** (`review-pipeline/scripts/work_queue.py`), built once
and domain-neutral; the processing step is passed in.

1. **The to-do list** is the items whose verdict is missing, out of date (a file it depends on
   changed) or old (rotation). New items join it when the producer lists them; items no longer
   listed leave it. When each item was first seen is kept, so its wait is known.
2. **The order is computed by code**, from what the producer knows: each item's `priority`
   (alert triage: severity, a bonus when the file implements a trust boundary according to the
   threat model, watched guards first), then new and changed before re-checks, then the longest
   waiting. The owning agent does not rank; it may **steer** with a reason
   (`priorities.json`: pin to the top, or hold until a date), which the queue applies and records.
3. **The pace is a daily budget in dollars.** Each investigation reports its cost (`cost_usd`,
   also on failure); the queue keeps the day's spend and starts no investigation once it reaches
   `--max-usd-per-day`. Each investigation also has a money cap (`max_usd`, a third reason for
   ADR-0039's last step), and turns and time stay as safeties. The job runs hourly; the budget,
   not the schedule, sets the pace.
4. **Each run reports how far behind the work is:** items left by band, the oldest waiting,
   today's spend against the budget.
5. **The agent is woken only when there is work:** a finding to verify, an item that failed,
   was rejected or came back incomplete, or once a day with the backlog line. An hourly job does
   not mean an hourly agent turn.

## Alternatives considered

- **The agent ranks the list.** It would use what the agent knows, but puts the whole backlog in
  its context on every run and an LLM back inside the loop, where its interventions (resubmitting
  jobs, changing arguments) were what went wrong.
- **An LLM ranking pass outside the agent.** It can weigh context, but costs on every run, ranks
  differently each time, and a bad ranking is silent. Kept as a later option: a re-rank of the
  head of the list, if the fixed rule is seen to misrank.
- **A budget in turns or calls.** Simpler to count, but not what the user decides on; money is,
  and the per-investigation cost is now recorded (ADR-0039).
- **A longer job.** Rejected in ADR-0039: the pace comes from the budget, not from the time one
  job may run.

## Consequences

- Alert triage clears its backlog in priority order within the user's budget, and appsec's weekly
  summary says how far behind it is.
- The daily budget is the product owner's decision, set per mission in the job's arguments.
- The news digest (data factory) is the second candidate; adopting the queue there will show
  whether `work_queue.py` is generic, and is a separate slice.
