---
name: code-health
description: Reference for the code reviewer — where reports go and what a finding contains, the labels, how to record a decision on a scan finding, the scan's reports and their limits, CI status, and turning a repeated finding into an automatic check.
---

# Code health: reference

Look things up here when you need them. How to spend your time is in your role description.

## A report

`$SHARED_DIR/reports/code-review/YYYY-MM-DD-<subject>.md`. The first line says whether anything
blocks and what the report covers. Each finding gets the next id `CR-NNN` (the last one used is
in your mental map) and contains:

- a label: `issue` (the code is wrong, or harder or riskier to change than it should be, and
  you can show how), `suggestion` (a concrete improvement), or `question` (you suspect
  something you could not show);
- where (`file:line`, the line quoted) and the quality criterion it bears on (`quality-model`);
- for an `issue`, its cost: the change it makes harder or riskier and why (a second place to
  update, a function that cannot be read in one pass, a dependency that ties two modules), or,
  for a defect, the events or input and the wrong result;
- what you read and what you tried in order to prove yourself wrong;
- the fix you would make, in a hand-off block the developers' coding assistant can act on,
  each fix preceded by a test that fails without it.

A report that finds nothing says what was read. Message the user directly only for something
that could lose data, money or availability.

## Scan findings

The reports in `$SHARED_DIR/analysis/` (`docs/practices/traceability.md` in your clone, "The
trace", explains how each is computed and where it can be wrong):

| File | What it holds |
|---|---|
| `operations.md` | For each operation: its entry points, what each reaches, the writes one reaches and another does not, calls the scan could not resolve |
| `writes.md` | Every database write, the component that owns its collection, the status changes it can make |
| `invariants.md` | Every invariant and what enforces it |
| `components.html` | The component map |
| `findings.json` | Every finding with its key, locations and, for a difference between entry points, the writes each one lacks |

What the trace found on a file or an operation, and what anyone has concluded about it:

```bash
node "$WORKDIR/repos/magi_v3/scripts/trace/decisions.mjs" about "$SHARED_DIR/analysis" <file path or baseline id>
```

Record your conclusion on a finding you examined, so that the user and your teammates can see it:

```bash
node "$WORKDIR/repos/magi_v3/scripts/trace/decisions.mjs" dispose "$SHARED_DIR/analysis" <key> <decision> "<what you found, with file:line>"
```

| Decision | When |
|---|---|
| `finding` | The code should change; give the report and `CR-NNN` |
| `dismissed` | The finding is mistaken; say what in the code shows it, at the places the finding names |
| `catalog` | The code is right and the catalog is not; the user decides catalog changes and reads these as questions |
| `reopen` | An earlier decision of yours was wrong |

A finding you have not examined needs no record. The tool refuses a `finding`, `dismissed` or
`catalog` without a location from the finding, and a reason reused from another finding. The
user checks a sample of dismissals; one found wrong comes back in your "Trace findings" region.

## CI and the cursor

`python3 $SHARED_DIR/skills/_team/repo-workspace/scripts/ci-status.py <sha> ...` (at most about ten
commits per call). A red commit on `main` is a blocking `issue`. `repo-workspace` lists the commits
since your cursor and moves it once you have reviewed them.

## A finding seen twice becomes a check

When the same kind of finding appears a second time, propose a check that would catch it every
time: a tripwire pattern (`scripts/audit/tripwires.sh`), a lint rule, a ratchet or a contract
test, with the pattern and how many places it hits today. Keep the proposals in your mental map.
