# Work queues: gather, rank, process under a budget, consolidate

**Status:** slices 1–4 built 2026-11-27 ([ADR-0040](../adr/0040-work-queues.md)); slice 5 (news) not started.

## The problem

MAGI DEV's alert triage clears its backlog at an accidental pace: one run a day, as many
investigations as fit in 12 minutes, in whatever order the producer listed the alerts. A
CRITICAL alert can wait behind fifty LOW ones; nobody sees how far behind the work is; and when
the pace was wrong, the agents changed the job's arguments by guesswork. Spend is bounded only by
the mission cap.

A person in the same seat keeps a running to-do list, adds new items as they arrive, works the
most important first, at a pace set by what they can afford, and knows how far behind they are.

## The pattern is not appsec's

Three loops in MAGI already have the same shape:

| Step | Alert triage (MAGI DEV) | News digests (data factory) | Report gate (MAGI DEV, `report-gate.py`) |
|---|---|---|---|
| **Gather** (code, no tokens) | `produce_items.py`: open alerts, watched guards | adapters fetch articles | new or changed reports in `reports/<area>/` |
| **Backlog** (stable ids, what changed) | `verdicts.json`: an item is due when new, when what it cites changed, or when its verdict is old | `is_new` against the previous digest; de-duplication by URL and title | `reports/gate/ledger.md`: a report is re-checked until accepted |
| **Rank** (code) | none: producer order | keyword hits, then recency (`process_news.py`) | none |
| **Process** | one Investigate per item, confirmation, refuter (LLM) | one Research call over the top 30 (LLM) | none: code only |
| **Check** (code) | schema, citations exist | — | every reference exists |
| **Consolidate** (for an agent) | findings for appsec to verify | the brief | rejections mailed to the author |
| **Budget** | calls per run, 12 minutes | top 30 items | none needed (no tokens) |

What differs is the processing step: per item with confirmation (triage), per batch (news),
none at all (the gate, which is code only and needs no budget). What is shared is everything
around it: a backlog that persists across runs, a ranking, a budget where tokens are spent, and a
report of what is left.

**Recommendation:** build the shared part once, as a small domain-neutral module in the
`review-pipeline` skill (`queue.py`), with the processing step passed in. Alert triage adopts
it now. The news digest is the second adopter, a later slice: it validates that the module is
really generic before a third one depends on it. Nothing in the module knows about code, alerts
or articles.

## The design

### 1. Items carry a priority; the producer computes it

The producer knows the domain, so it scores each item (`"priority": <number>`, higher first).
For alert triage:

- severity: critical 40, high 30, medium 20, low 10 (scanner's own label);
- +15 when the alert's file implements a trust boundary: the threat model's "Implementing
  Files by Boundary" section lists them, and the reference copy has it, so this is a lookup, no
  model;
- watched guards: 50 (a file that holds a security property on its own).

The queue orders by: an override first, then priority, then how long the item has waited (first
seen, oldest first). Re-checks of an old verdict ("rotation") come after new and changed items.

### 2. The owning agent steers, it does not rank

The agent receives the ranked backlog's head in each run's report, not the whole list. To change
the order it writes `priorities.json` in the queue's state folder: `{"<item id>": {"pin": "top" |
"skip-until": "<date>", "reason": "…"}}`. The queue applies it and records it in the ledger.
Judgement enters where it is cheap: a few lines a week, not a decision per item.

Ranking by an LLM pass was considered: it can weigh context, but it costs on every run, ranks
differently each time, and a bad ranking is silent (an important item just waits). It can be
added later as a re-rank of the head of the list, if the fixed rule is seen to misrank (a real
finding confirmed late).

### 3. Budgets in dollars, turns as the safety (built with a per-item budget too: see ADR-0040)

- **Per item:** each Investigate reports its own cost (`cost_usd`, from the calls its hooks
  metered). A kind may set `max_usd`; reaching it is a third reason for the sub-agent's last
  step, beside time and turns (ADR-0039's mechanism: answer from what you have, say what is
  missing). The turn cap stays.
- **Per day:** the queue takes a daily budget (`--max-usd-per-day`). It records each
  investigation's cost in its state (`spend.json`, per UTC day) and starts no new investigation
  once the day's spend reaches the budget. A real finding costs about four investigations
  (two confirmations and the refuter), so the budget is checked before each one, not per item.
- **Per run:** the 12-minute cut-off stays, so a run ends before the job's 30-minute limit.

The job runs **hourly**; the daily budget, not the schedule, sets the pace. A backlog is worked
through within a day or two, then each day handles what is new or changed.

### 4. The report says how far behind the work is

Each run's `summary.json` gains a backlog section: items left by priority band, the oldest
waiting item and since when, today's spend against the budget. Appsec's weekly summary to the
user quotes it.

### 5. The agent is woken only when there is something for it

Hourly runs must not mean hourly agent turns. The job no longer notifies on every completion;
the run itself mails its agent (through the Tool API) when there is work: a finding to verify,
failures above a threshold, or once a day with the backlog line. A failed job still notifies
(the platform does that).

## Slices

1. **Cost per investigation.** Investigate returns `cost_usd`; `max_usd` per kind as a third
   wind-down reason. Measure the cost of the next runs before setting the figures.
2. **The queue.** `queue.py`: priority and age ordering, overrides, the daily budget, the backlog
   report; `review.py` uses it. Tests in `tests/review_pipeline/`.
3. **Alert triage adopts it.** Priority in `produce_items.py` (severity, boundary, guards);
   hourly schedule with a daily budget; the run mails appsec only when there is work; the skill
   explains overrides and the backlog line. Written to `magi-dev-1` while it is suspended.
4. **ADR-0040**, the review-pipeline skill, the resilience doc.
5. **Later: the news digest adopts the queue** (its own processing step), which settles whether
   the module is generic.

## Decisions for the product owner

- The daily budget for alert triage, and the per-investigation cap: proposed after measuring
  slice 1 on real runs.
- Whether the news digest adoption (slice 5) is scheduled now or left until a news mission needs
  it.
