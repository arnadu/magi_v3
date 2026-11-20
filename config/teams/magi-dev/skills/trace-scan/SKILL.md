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
| `findings.json` | Every finding, with a stable `key` |
| `findings-<agent>.md` | Your area's findings: what is new since this mission's previous fetch, where they are, what you have concluded; it is also the "Trace findings" region of your mental map |
| `catalog-questions.md` | The reviewers' `catalog` decisions, for the user |

CodeQL's security results are not here: they describe possible vulnerabilities, so they go only
to the repository's code scanning, which only maintainers see. Ask the user for them when a
review needs them; never describe one anywhere public.

How each part is computed, and where it can be wrong: `docs/practices/traceability.md` in the
repository ("The trace"). Read that section once before you rely on a finding.

## Answering a question from the reports

The reports answer most questions about who can do what, and through which code, faster than a
search of the code. Look there first; then confirm in the code what you will rely on.

| Question | Where to look |
|---|---|
| Who can ask for an operation, and through which entry points | `operations.md`, the operation's section: one row per entry point, with its actor |
| Can a given actor (the control copilot, an agent) do it at all | The same section: no row with that actor means no entry point serves it, and the trace says so under the table |
| Does every way in reach the operation's one implementation | The "Reaches home" column; "Unresolved calls" says where it may be incomplete |
| Which database writes a request can lead to | The "Writes reached" column; `writes.md` for every write to one collection |
| Which status changes the code can make, and whether the catalog allows them | `writes.md`, the "Status" column |
| What keeps an invariant true | `invariants.md` |
| What one entry point reaches, function by function | `npm run trace -- reach <operation id or entry point name> --analysis "$SHARED_DIR/analysis"` in your clone |

A section of `operations.md`:

```
## `mission.create-draft`

Start a mission as an editable draft. Actors: OP, CC. Home: `cp-mission-ops`.

| Entry point | Actor | Where | Reaches home | Writes reached | Via HTTP | Unresolved calls |
|---|---|---|---|---|---|---|
| tool `CreateDraft` | CC | `packages/control-plane/src/copilot-draft-tools.ts:26` | yes | `missions.insertOne@packages/control-plane/src/mission-drafts.ts:90` | — | `collection`, `get` |
| route `POST /draft` | OP | `packages/control-plane/src/mission-routes-lifecycle.ts:269` | yes | `missions.insertOne@packages/control-plane/src/mission-drafts.ts:90` | — | `get` |

None.
```

- The heading line is the catalog: the operation's intent, the actors who may ask, and its
  home (the component meant to hold its one implementation).
- Each row is an entry point the code tags with this operation: its kind and name, the actor
  that kind serves, and where it is declared. A route or a mission-machine route serves the
  operator (`OP`), except the mission copilot's own gateway routes (`MC`); a control-copilot
  tool or action, `CC`; a mission-copilot tool, `MC`; an agent tool or a directory agents
  write requests into, `AG` (the copilots have most agent tools too); a Tool API name, a
  background job (`JOB`); a timer or change stream, the platform (`PLT`).
- "Reaches home": whether the calls from it reach code in the home component. "Writes
  reached": the database writes those calls lead to. "Via HTTP": the mission-machine routes it
  calls. "Unresolved calls": calls the scan could not follow, so "no" there may be the scan's
  limit rather than the code's.
- Under the table, the trace's findings on the operation, or "None.". Here both ways in reach
  the same one write, in the home: one implementation, two entry points.

## How to use a finding

A finding is a lead for the review you are doing, not an item on a list: nobody expects every
one to be examined, and one left alone costs nothing. A wrong conclusion does.

1. **Look up what concerns your subject.** Before you conclude about a file, an operation or a
   baseline id, ask the trace what it found there:
   ```bash
   node "$WORKDIR/repos/magi_v3/scripts/trace/decisions.mjs" about "$SHARED_DIR/analysis" <file path or baseline id>
   ```
   It lists the findings in your area that touch it, and what any reviewer has concluded about
   them (`--all` for every area).
2. **It is evidence, not a verdict.** Open the `file:line` it cites in your clone, at the
   scanned commit, and confirm what it says. Reach can be incomplete where the report lists
   unresolved calls; "the trace cannot follow this call" is a claim too, to check against the
   entry point's row in `operations.md`.
3. **Quote the row you used.** A report that relies on the trace cites the finding's `key` and
   the report row, as with any evidence (`working-agreements`).
4. **Record what you concluded** on a finding you examined:
   ```bash
   node "$WORKDIR/repos/magi_v3/scripts/trace/decisions.mjs" record "$SHARED_DIR/analysis" <key> finding "<your finding id; the file:line that shows it>"
   node "$WORKDIR/repos/magi_v3/scripts/trace/decisions.mjs" record "$SHARED_DIR/analysis" <key> catalog "<why the code is right and the catalog is not; the file:line that shows it>"
   node "$WORKDIR/repos/magi_v3/scripts/trace/decisions.mjs" record "$SHARED_DIR/analysis" <key> dismissed "<why the trace is wrong; the file:line that shows it>"
   node "$WORKDIR/repos/magi_v3/scripts/trace/decisions.mjs" record "$SHARED_DIR/analysis" <key> reopen "<why your earlier conclusion was wrong>"
   ```
   Each conclusion names the `file:line` you read for *that* finding, at one of the places it
   names (for a difference between entry points, a write one of them does not reach); the same
   reason for two findings is refused. Your latest record per finding counts. A finding whose
   text changes gets a new key.
5. **When the code and the catalog disagree**, decide which is wrong: a finding against the
   code, or `catalog` when the code is right and the catalog is not. A `catalog` record is a
   question for the user, who approves every catalog change. A dismissal is for a finding that
   is simply wrong. Never treat the catalog as automatically right.

Each finding is its own question. Having checked others of the same kind is not evidence for
this one, and neither is another reviewer's conclusion: read the code it points to. The user
checks a sample of dismissals against the code.

For one question without waiting for a scan, your clone answers directly (TypeScript language
service, seconds): `npm run trace -- def <name>`, `refs <file:line>`, `callers <file:line> --depth 2`.
A search of the code (`grep`) confirms what a report says; on its own it rarely shows that
something is missing, because an entry point can be in any of many files.

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
