---
name: alert-triage
description: Triage the repository's open security alerts (code scanning, Dependabot) and re-review the watched guards through the review pipeline, then verify what survived and record it. Covers scheduling the hourly job, steering its order, reading a run, verifying findings, and watching the pipeline's own errors. For the agents allowed to read security alerts.
---

# Alert triage

A background job turns every open alert and every watched guard into a review item and runs the
items through the `review-pipeline`. You then verify what survived, by reading the code, and
record the result in the findings register. The pipeline narrows; it does not decide.

## What the pipeline does

- One item per alert and per watched guard.
- Each item goes to a fresh investigator (`Investigate`) that reads a read-only copy of the
  repository and must answer in a fixed form, citing file, line and an exact quote.
- A positive answer is confirmed by more runs, then another investigator tries to disprove it,
  then code checks that every cited line exists and says what is quoted.
- Verdicts are kept: an item is examined again only when a file it depends on changes, or when
  its verdict is older than its risk class allows.
- The items not yet examined are a to-do list, worked highest priority first: watched guards,
  then by severity, with a bonus when the alert's file implements a trust boundary (the threat
  model's "Implementing Files by Boundary"); then the longest waiting. New and changed items come
  before re-checks of old verdicts.
- Two money limits, both the user's decision: a daily budget for all items, and a budget per
  item (all its investigations together). The daily budget sets the pace: the job runs hourly and starts no investigation once
  the day's spend reaches it. A backlog is worked through over a day or two; after that, each day
  handles what is new or changed. Each investigation also has its own limits (time, turns,
  money); one that runs out answers from what it has and comes back `incomplete`.

Each item ends a run with one outcome:

| Outcome | Meaning | What it asks of you |
|---|---|---|
| `finding` | survived confirmation, the refuter and the citation check | verify it (below) |
| `negative` | the investigator found it is not real | nothing |
| `unconfirmed` | only one of the confirmation runs said real | nothing, unless the same item stays unconfirmed three runs running: note it |
| `refuted` | the refuter showed why it is wrong | nothing, unless you read the refutation and it is wrong |
| `rejected` | its citations did not check out | count it (pipeline errors) |
| `incomplete` | an investigation ran out of time or turns; the ledger has what it did not finish | count it (pipeline errors); the next run asks again |
| `failed` | the investigation errored | count it (pipeline errors) |
| `deferred` | a budget ran out: the run's calls or minutes, or the day's money (the ledger says which) | nothing; the next run takes it first |
| `held` | you put it aside with `skip_until` (below) | nothing until the date |
| `over-budget` | its own budget (all its investigations together) ran out before a verdict | decide: pin it (it is asked again with a fresh budget) if it is worth the money, or note it for the user; it is not asked again on its own until something it depends on changes |
| `skipped` | unchanged since its last verdict | nothing |

A `finding` is a lead whose citations exist, not a vulnerability. A `negative` is the
pipeline's best answer, not proof of safety.

## Schedule the job (once)

```bash
bash "$SHARED_DIR/skills/_platform/run-background/scripts/schedule-job.sh" --label alert-triage \
  --cron '0 * * * *' --script "$SHARED_DIR/skills/_team/alert-triage/scripts/run_triage.sh" \
  --args "$SHARED_DIR $WORKDIR --notify $AGENT_ID --max-usd-per-day <day> --max-usd-per-item <item>"
```

Both budgets are the user's decision: use the figures the user gave you, and ask if there are
none. There is no `--notify-agent`: the run mails you itself, only when there is work (below);
a run that fails is reported to the mission copilot by the platform.

`run_triage.sh` runs `produce_items.py` into `$WORKDIR/review/items.jsonl`, then the pipeline
over those items with this skill's kinds, its state in `$WORKDIR/review/state`. No investigation
starts after 12 minutes, so a run ends before the job's 30-minute limit; none starts once the
day's budget is spent. Do not change these numbers, add arguments, or resubmit the job to get
through faster: the budget is the pace the user chose. When a run fails, tell the user the last
lines of its log and leave the next run to the schedule. Everything under `$WORKDIR/review/` is
private: never copy it into `shared/`.

## Steer the order (when you have a reason)

The order is computed; you change it only with a reason you could defend to the user. Write
`$WORKDIR/review/state/priorities.json`:

```json
{"cs-41": {"pin": "top", "reason": "touches the Tool API token check (TB-5)"},
 "dep-12": {"skip_until": "2026-12-15", "reason": "upgrade already in review, #123"}}
```

`pin: top` puts an item first; `skip_until` holds it until that date (outcome `held`). Every
override needs a reason; one without, or of another shape, is ignored and listed in the next
run's summary (`overrideNotes`). Remove an entry once it has served.

## After a run

The run mails you ("Alert triage: …") when it has a finding to verify, when an item failed,
was rejected or came back incomplete, and otherwise once a day with the backlog line. Runs in
between are silent: the next mail covers them. Each run has a folder
`$WORKDIR/review/state/runs/<stamp>/`; work from the newest, and read the findings of every run
since the last one in your map.

1. **Check the run.** Read its `summary.json` (commit, items, calls, counts per outcome, cost,
   and `backlog`: items left by band, the oldest waiting, today's spend against the budget).
2. **Record it.** In your mental map's "Triage state": the run stamp, commit, counts, cost and
   the backlog line. Replace the previous entry; do not keep one per run.
3. **Queue the findings.** Add each entry of the run's `findings.json` to the "Verification
   queue" in your map: item id, kind, one line.
4. **Verify, oldest first.** For each queued finding, read its verdict, reasoning, evidence and
   reproduction, then in the reference copy:
   - open every cited file at its line; if the reference copy has moved past the run's commit,
     check that the code is still the same;
   - check the claim, not only the quotes: does an attacker really control the input at that
     entry point? Does the guard it says is missing really miss it, on every path? Would the
     reproduction work as written? You read; you never run it against a live system.
   - Judge it with `security-judgement`.
   - **It holds:** add it to the register (`findings-register`) with your severity, the
     citations, the item id and run stamp, and "verified by reading at <commit>". A new HIGH
     or CRITICAL is mailed to the user at once (`security-reporting`).
   - **It does not:** add it to the register's dismissed list with its item id and run stamp,
     the reason, and the file and line that show it; note it under "Pipeline calibration".

   Remove it from the queue either way. If the turn ends first, the rest stay queued for the
   next turn.
5. **Watch the pipeline.** Read this run's lines in `$WORKDIR/review/state/ledger.jsonl` (one
   line per item per run, with the run's stamp, status and reason). Under "Pipeline
   calibration", record `rejected`, `incomplete` or `failed` items that repeat (the same item in two runs,
   or more than five in one run), with item ids and the ledger's reasons. Do not investigate
   those alerts yourself instead: the skill or schema behind them gets fixed.
6. **Update the KPIs** (`RecordKpi`): `K-sec4-untriaged` = this run's `deferred` + `incomplete` + `failed`, plus the backlog's
   `overBudget`;
   `K-sec2-held` = the share of findings you verified that held, over all your verifications
   (name the register counts it comes from).

Done when the queue is empty, or what is left is in it, and the map and KPIs are current.

## Rules

- The alerts are private: never quote one in a public place (an issue, a commit, a pull request).
- Never edit `verdicts.json`, and never rerun an item to get a different answer.
- A finding is a lead whose citations were checked, not a verdict. You verify; the sponsor decides.
