---
name: review-pipeline
description: Review a list of items about a codebase one by one with Investigate, and let code decide what counts: what is due, confirmation runs, a refuter, and checks that every cited file, line and quote exists. Run it as a background job.
---

# Review pipeline

## Purpose

Work through many review items (scanner alerts, open attack-matrix cells, catalog
disagreements, changed entry points) without reading them all in your own context, and without
trusting any single model answer. Each item gets one clean-context investigation; a possible
finding gets confirmation runs and a refuter; code checks the evidence; unchanged items are not
reviewed again until their risk class says so.

## What you supply

**Items** (`items.jsonl`, one JSON object per line):

```json
{"id": "cs-214", "kind": "code-scanning", "facts": {"number": 214, "rule": "magi-path-from-request"},
 "briefing": "Rule … at packages/control-plane/src/x.ts:88. Entry point … Invariants …",
 "deps": {"files": ["packages/control-plane/src/x.ts", "packages/agent-runtime-worker/src/safe-path.ts"]}}
```

`id` is stable across runs (it keys the stored verdict). `deps.files` are the files the verdict
depends on before anything is read (the item's location, the guards the catalog names); the
files the answer cites are added to them. Optional: `priority` (a number, higher is worked first)
and `band` (a label the backlog is counted by, such as a severity); the producer computes both,
since it knows what the items are.

**Kinds** (a folder of `<kind>.json`, one per kind of item):

```json
{"kind": "code-scanning", "question": "Is code-scanning alert {number} ({rule}) real?", "max_turns": 30,
 "skill": "/missions/.../skills/_team/triage-code-scanning/SKILL.md",
 "schema": {"type": "object", "required": ["verdict", "evidence"], "properties": {…}},
 "mode": "triage", "risk": "boundary",
 "positive": {"field": "verdict", "values": ["real"]},
 "refuter_skill": "/missions/.../skills/_team/refute/SKILL.md",
 "severity_field": "severity", "reproduction_field": "reproduction"}
```

- `question` is filled from the item's `facts`. `skill` and `refuter_skill` may be relative to
  the descriptor's folder.
- `mode`: `triage` (is this alert real?) needs two of three runs to agree; `discovery` (find a
  way to break this) keeps a single candidate and relies on the refuter.
- `risk` (`boundary`, `platform`, `ordinary`) sets how long an unchanged verdict stands.
- `positive` says which answers are candidate findings.
- `max_turns` and `max_usd` (optional) are each investigation's turn and money budgets; without
  them, Investigate's defaults. An investigation that reaches either, or its time, answers from
  what it has and comes back `incomplete`.
- The schema's evidence items must carry `file` (relative to the repository), `line` and
  `quote`: acceptance checks each one at the reference commit. A quote found exactly once
  elsewhere in the file has its line corrected (`relocated_from` records the cited one); a
  quote found nowhere rejects the answer.

## Run it

As a background job (see `run-background`), against a reference copy kept by a platform task:

```bash
python3 $SHARED_DIR/skills/_platform/review-pipeline/scripts/review.py \
  --items $WORKDIR/review/items.jsonl --kinds $WORKDIR/review/kinds \
  --state $WORKDIR/review/state --reference magi-v3 \
  --max-usd-per-day 2 --max-usd-per-item 1 --max-minutes 12 --max-calls 40
```

Keep `--state` in your workdir: verdicts about security questions are private to you.

The items not yet reviewed are a to-do list (`scripts/work_queue.py`): a run takes the due items
in order (anything you pinned, then new and changed before re-checks, then priority, then the
longest waiting) and starts no investigation once a budget is reached: today's money
(`--max-usd-per-day`, per UTC day), the run's minutes (`--max-minutes`, under the job's
30-minute limit) or its calls. Schedule the job often (hourly) and let the daily budget set the
pace. To change the order with a reason, write `state/priorities.json`:
`{"<id>": {"pin": "top", "reason": "…"}}` or `{"<id>": {"skip_until": "YYYY-MM-DD", "reason":
"…"}}`; an entry without a reason is ignored and reported.

## What you get

- `state/runs/<stamp>/summary.json`: the commit, items examined, calls used, a count per
  outcome, the run's cost, and `backlog`: what is left by band, the oldest waiting and since
  when, today's spend against the daily budget.
- `state/runs/<stamp>/findings.json`: what survived. Triage these: verify each, then file it.
- `state/ledger.jsonl`: every item examined and why (new, changed, rotation), with the problems
  acceptance found and what it cost.
- `state/verdicts.json`: the store; do not edit it.

Outcomes: `finding` (survived everything), `negative`, `unconfirmed` (one run of three),
`refuted`, `rejected` (its evidence did not check out), `skipped` (unchanged), `deferred` (a
budget ran out; the ledger says which), `held` (put aside by `skip_until`), `over-budget` (the item's own budget, `--max-usd-per-item`,
ran out before a verdict: kept as a marker and not asked again until something it depends on
changes or you pin it), `incomplete` (an
investigation ran out of time, turns or money; asked once more on the next run), `set-aside`
(incomplete twice in a row: kept as a marker and not asked again until something changes or you
pin it) and `failed` (the
investigation errored).

## Rules

- A finding is a lead with checked citations, not a certificate. Verify it before you file it.
- Never edit `verdicts.json` to suppress an item; a verdict changes when what it depends on does.
- The daily and per-item budgets are the user's decision, not yours: run with the figures you
  were given.
