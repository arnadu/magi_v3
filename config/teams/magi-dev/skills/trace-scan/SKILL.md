---
name: trace-scan
description: The trace of the MAGI repository against its baseline catalog — what it reports, how to read a finding, how to record what you decided, and (code reviewer) how its scheduled job is set up.
---

# Trace scan

## What it is

The repository's CI runs `npm run trace` on every push to `main`: it scans the code and joins
what it finds to the baseline catalog (`docs/product/`, `docs/architecture/components.md`,
ADR-0036), and publishes its reports to the repository's `trace` branch. A scheduled job of this
mission fetches the latest of them into `$SHARED_DIR/analysis/`:

| File | Question it answers |
|---|---|
| `index.md` | The commit and time of the scan, headline numbers, findings by kind, what is new |
| `operations.md` | Each operation's entry points, what each reaches, how they differ |
| `writes.md` | Every database write, the component that owns its collection, the status changes it can make |
| `invariants.md` | Every invariant and what enforces it |
| `components.html` | The component map |
| `todo.json` | Every finding, with a stable `key` |
| `todo-<agent>.md` | Your share of the findings, the open ones, new ones (since this mission's previous fetch) first; it is also the "Scan to-do" region of your mental map |

CodeQL's security results are not here: they describe possible vulnerabilities, so they go only
to the repository's code scanning, which only maintainers see. Ask the user for them when a
review needs them; never describe one anywhere public.

How each part is computed, and where it can be wrong: `docs/practices/traceability.md` in the
repository ("The trace"). Read that section once before you rely on a finding.

## How to use a finding

1. **It is evidence, not a verdict.** Open the `file:line` it cites in your clone, at the
   scanned commit, and confirm what it says. Reach can be incomplete where the report lists
   unresolved calls.
2. **Quote the row you used.** A report that relies on the scan cites the finding's `key` and the
   report row, as with any evidence (`working-agreements`).
3. **Record what you decided**, one finding at a time:
   ```bash
   node "$WORKDIR/repos/magi_v3/scripts/trace/todo.mjs" dispose "$SHARED_DIR/analysis" <key> finding "<your finding id; the file:line that shows it>"
   node "$WORKDIR/repos/magi_v3/scripts/trace/todo.mjs" dispose "$SHARED_DIR/analysis" <key> dismissed "<why it is not a defect; the file:line that shows it>"
   node "$WORKDIR/repos/magi_v3/scripts/trace/todo.mjs" dispose "$SHARED_DIR/analysis" <key> catalog "<why the code is right and the catalog is not; the file:line that shows it>"
   node "$WORKDIR/repos/magi_v3/scripts/trace/todo.mjs" dispose "$SHARED_DIR/analysis" <key> deferred "<what it waits for>"
   node "$WORKDIR/repos/magi_v3/scripts/trace/todo.mjs" dispose "$SHARED_DIR/analysis" <key> reopen "<why>"
   ```
   A finding or a dismissal is a claim about the code, so it leaves your open list only with
   the `file:line` you read for *that* finding; the same reason for two findings is refused, as
   is "same pattern as another one". A dismissal must address what the finding names: cite one
   of its locations (for a difference between entry points, one of the writes an entry point
   does not reach) and say what you found there. "The scan cannot follow this call" is a claim
   too: check it against the entry point's row in `operations.md`, which lists what was reached
   and the calls that were not. Deferring does not close anything: a deferred finding stays
   on your to-do under "Deferred" until you decide it. Your to-do is rebuilt after each record;
   your latest record per finding counts. A finding whose text changes gets a new key and comes
   back.
4. **When the code and the catalog disagree**, decide which is wrong: a finding against the code,
   or `catalog` when the code is right and the catalog is not. A `catalog` record is a question
   for the user, who approves every catalog change; it is listed in
   `$SHARED_DIR/analysis/catalog-questions.md`. A dismissal is for a finding that is simply
   wrong. Never treat the catalog as automatically right.

For one question without waiting for a scan, your clone answers directly (TypeScript language
service, seconds): `npm run trace -- def <name>`, `refs <file:line>`, `callers <file:line> --depth 2`.

## Setting up the job (code reviewer, once)

The job runs as you, so you create its schedule (a schedule file must belong to its author):

```bash
bash "$SHARED_DIR/skills/_platform/run-background/scripts/schedule-job.sh" \
  --label trace-scan \
  --cron "30 2,8,14,20 * * *" \
  --script "$SHARED_DIR/skills/_team/trace-scan/scripts/run-trace.sh" \
  --args "$SHARED_DIR $WORKDIR" \
  --agent "$AGENT_ID" \
  --notify-subject "Trace scan fetched"
```

It runs half an hour before each code review and takes well under a minute: it only fetches
and copies. To run it once now, use `submit-job.sh` with the same `--script` and `--args`. If a
run fails, its log is in `$SHARED_DIR/logs/bg-<jobId>.log`; report the failure to the user rather
than working around it. `index.md` names the commit and time of the scan: a scan older than the
latest commit means CI has not published yet, or failed.
