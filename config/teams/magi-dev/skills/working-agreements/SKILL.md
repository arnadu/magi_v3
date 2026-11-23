---
name: working-agreements
description: Rules every reviewer on this team follows — findings rather than certificates, checks proven on a known positive, verifying the facts in your own proposed text, consistency with your earlier reports and your teammates', your own report folder, requests addressed to several agents, checklists, and citations that resolve in the code.
---

# Working agreements

These apply to every report you write. Each rule exists because an earlier report broke it.

## 1. Findings, not certificates

A report lists **findings**, each with the evidence that establishes it (the command and the
relevant part of its output, or the `file:line` read), and **what you examined**: the files,
commits, rows or claims you looked at. It does not certify: no "APPROVE", "all controls hold",
"held against N attacks", "no drift", "compliant" or "no violations". Nobody can check an
absence, and those words were where invented evidence hid. Having found nothing is written as
"no finding in what I examined", with the list.

Where a checklist row or a claim needs a verdict, it carries its own evidence (rule 8); anything
you did not check is **unverified**, with the reason. For a rule or statement only a reviewer can
judge, sample it (5–10 instances, listed) or mark it unverified.

## 2. A check is trusted only after it has caught a known positive

A command that returns nothing, all zeros, or "no hits" proves nothing until you have seen it
find something. Before relying on a check, run it once against a case you know is positive (a
file you know contains the pattern, a planted sample in your working folder, a commit you know
changed the thing). `tripwires.sh --selftest` is the model. A check whose output contradicts
your conclusion means the check or the conclusion is wrong: resolve it before writing.

## 3. Verify the facts in your own proposed text

A proposed edit, a hand-off block or a summary must not introduce a new error. Every fact you
write in it (an issue's state, a feature's existence, a value, a command) is checked like any
claim you review: issue states on the GitHub page (FetchUrl
`https://github.com/<owner>/<repo>/issues/<n>`), features and values in the code. If you can't
check it, leave it out.

## 4. Stay consistent with what you and your teammates have reported

Before a summary, a verdict or an all-clear, re-read your own earlier reports and register, and
search your teammates' reports (`$SHARED_DIR/reports/`) for anything on the same subject. A new
statement that contradicts an earlier one must say which is right and why. Declaring a rule
unbroken while a teammate's report shows it broken is an error.

## 5. Measured claims cite their numbers

"Trending down", "has dropped", "is stable", "high compliance" need the numbers and the command
that produced them. A document's statement ("Done", "decomposed", "accurate") is a claim to
check, not evidence: compare it with what you measure.

## 6. Your own report folder

Write only in your own folder: appsec in `reports/security/`, code-reviewer in
`reports/code-review/`, documenter in `reports/docs/`, qa-lead in `reports/qa/`. Never write, rename or delete a file in a
teammate's folder. Start report file names with the date; if a file with that name exists, add
`-2`, `-3`.

## 7. Requests addressed to several agents, and parts you skip

When a message names several of you, do only the part that belongs to your role and say in your
reply which part you left to whom (a documentation sweep is the documenter's, a security review
appsec's, a code review the code reviewer's, a journey or usability review the qa-lead's). When you don't do part of what was asked (it is
ambiguous, blocked, or someone else's), say so explicitly in the report and in your reply, with
the reason. Silence reads as "done".

## 8. Walk your checklist: look for what is missing

Reading what exists finds what is wrong with it; it cannot find what was never built. Each of
you has checklists of what *should* exist, in your skills' `checklists/` folders:

| Agent | Checklists |
|---|---|
| appsec | `appsec-foundations/checklists/security-controls.md` |
| code-reviewer | `code-review/checklists/change-completeness.md` |
| documenter | `doc-consistency/checklists/documentation-coverage.md` |
| qa-lead | `qa-journeys/checklists/journey-checks.md`, `test-layers.md`; `ux-review/checklists/ux-heuristics.md`; `operations-inventory/checklists/inventory-checks.md` |

When your skill says to use one, copy it and fill in **every row** (verdict and evidence),
then check it is complete:

```bash
python3 $SHARED_DIR/skills/_team/working-agreements/scripts/checklist.py start <checklist> --out <your-report-folder>/checklists/YYYY-MM-DD-<name>.md
python3 $SHARED_DIR/skills/_team/working-agreements/scripts/checklist.py summary <your-report-folder>/checklists/YYYY-MM-DD-<name>.md   # exits 1 until complete
```

Every `missing` or `fail` row is a finding in your report. Paste the summary into the report.
A review whose checklist is incomplete says so; it does not conclude. If an item should be on
your checklist and isn't, propose it in your report.

The report includes the `summary` output exactly as the script printed it. A table of your own
in its place — other ids, other rows, all ticked — is not a checklist result.

## 9. Every code reference resolves, and the gate checks it

A function, file, line, route, test, commit or id you name must exist in the code you reviewed.
A plausible name written from memory — a handler called what it ought to be called, a commit
summarised from what it ought to contain — reads like evidence and is the most damaging error a
review can contain. Name only what you have read in the clone, in this turn; quote commit
subjects from `git log`, test names from `grep -n 'it("' <file>` (in full, no `head`), and code
by copying it.

**The report gate** (`report-gate.py`, a scheduled job: code, not an agent) checks every new or
changed report in `reports/<area>/`: names, files and lines, routes, test names, commit hashes
and the subjects beside them, `TB-`/`F-`/`SC-`/`sec.*` ids, system paths, and quoted code blocks.
A report with any reference that does not exist is **rejected**, and you are sent the list. Look
each one up, then correct it or remove the claim that rests on it; never re-word around it. The
gate re-checks the report on its next run. A report counts only once `reports/gate/ledger.md`
shows it `accepted`.

Run the same check yourself before you hand a report over, so it is accepted first time:

```bash
python3 $SHARED_DIR/skills/_team/working-agreements/scripts/check-citations.py <report.md> <clone>
```

It proves existence, not meaning: a real function cited for the wrong behaviour still passes, so
read the code as well. `--selftest <clone>` shows it catching an invented reference of each kind
(rule 2).

## 10. Scan findings are evidence to confirm

The trace's reports and findings (`trace-scan`) are evidence, not verdicts. Before a
report relies on a finding, open the `file:line` it cites at the scanned commit and confirm it;
cite the finding's key with the row you used. Record what you decided with `decisions.mjs record`,
one finding at a time: a finding or a dismissal names the `file:line` that establishes it for
that finding. Having checked a similar finding is not evidence for this one. A scan that says
nothing about a question is not an all-clear: say what you read.

