---
name: alert-triage
description: Triage the repository's open security alerts (code scanning, Dependabot) and re-review the watched guards, item by item through the review pipeline, so code decides what counts. For the agents allowed to read security alerts.
---

# Alert triage

Each day: turn the open alerts and the watched guards into review items, run them through the
`review-pipeline` as a background job, then work through what survived.

## Run

As one background job (see `run-background`):

```bash
SK=$SHARED_DIR/skills/_team/alert-triage
python3 $SK/scripts/produce_items.py --reference magi-v3 --out $WORKDIR/review/items.jsonl
python3 $SHARED_DIR/skills/_platform/review-pipeline/scripts/review.py \
  --items $WORKDIR/review/items.jsonl --kinds $SK/kinds \
  --state $WORKDIR/review/state --reference magi-v3 --max-calls 40
```

`produce_items.py` reads the alerts with the `security-alerts` tool and the repository from the
reference copy. Items whose dependencies have not changed are skipped by the pipeline, so a
daily run costs little once the backlog is through.

## Then

Read `state/runs/<latest>/summary.json` and `findings.json`. For each finding:

1. Verify it yourself in the reference copy: open each cited file at its line.
2. If it holds, add it to the findings register (private, never a public issue).
3. If it does not, record why in the register's dismissed list; do not edit `verdicts.json`.

`rejected` and `failed` items in the ledger are not findings; look at them only when many
appear: a skill or a schema may need fixing.

## Rules

- The alerts are private: never quote one in a public place (an issue, a commit, a pull request).
- A finding is a lead whose citations were checked, not a verdict. You verify; the sponsor decides.
