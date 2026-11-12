---
name: hotspot-analysis
description: Find where review effort pays — source files that change often and are complex — from git history alone, track the list over time, and pick the next module for a deep review.
---

# Hotspot analysis

Defects concentrate where frequent change meets complexity. A file that is complex but never
changes is a low priority; a simple file that changes often is fine; a complex file that changes
every week is where the next bug is. Run weekly.

## Run

```bash
H=$SHARED_DIR/skills/_team/hotspot-analysis/scripts
OUT=$SHARED_DIR/reports/code-review/hotspots
mkdir -p $OUT
python3 $H/hotspots.py $WORKDIR/repos/<repo> --days 90 --top 20 --json $OUT/$(date -u +%F).json
```

`score = revisions in the period × complexity`, where complexity is the total indentation of
the file's non-blank lines (a proxy that needs no installed tools and tracks branching depth).
Tests, generated files and `experimental/` are excluded.

## Read it

1. **Compare with the previous week's JSON** in the same folder: what entered, what left, what
   grew. A file entering the top 10 or growing in complexity while being changed often is the
   signal; say why it is changing (read the commit messages: features piling up, repeated fixes?).
2. **Repeated fixes are the strongest signal.** `git -C <clone> log --since="90 days ago"
   --oneline -- <path> | grep -ci fix` — a hotspot fixed again and again needs a design look, not
   another patch.
3. **Cross-check the structure inventory, against the measurement**: is the file on
   `scripts/audit/structure.allow.json`, and does `docs/code-structure.md` record a reason and a
   plan for it? Then test that reason against what you measured: a row that says "Done" or
   "decomposed" for a file that is still a top hotspot (high churn, many fixes, still over the
   size limit) is a finding about the row, not a reason to skip the file.
4. **Trend claims cite numbers.** "The fix rate has dropped since the refactor" needs the fix
   counts before and after, from `git log --since/--until`; otherwise don't say it.

## Output

A short section in your weekly report (`$SHARED_DIR/reports/code-review/YYYY-MM-DD-weekly.md`):
the top 10 with the change since last week, the one or two files you recommend for a deep review
or a refactor and why, and the module you will deep-review next. Keep the rotation and the
last-reviewed date per module in your mental map. `working-agreements` applies.
