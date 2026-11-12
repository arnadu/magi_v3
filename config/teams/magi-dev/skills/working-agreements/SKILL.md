---
name: working-agreements
description: Rules every reviewer on this team follows — the evidence behind any "pass", checks proven on a known positive, verifying the facts in your own proposed text, consistency with your earlier reports and your teammates', your own report folder, and requests addressed to several agents.
---

# Working agreements

These apply to every report you write. Each rule exists because an earlier report broke it.

## 1. No evidence means unverified, never compliant

Every "pass", "consistent", "no violations", "verified" or "accurate" in a report cites what
established it: the command and the relevant part of its output, or the `file:line` read. If you
did not check something, write **unverified** and why; never fill the gap with "no violations
observed". For a rule or statement that only a reviewer can judge, sample it (5–10 instances,
listed) or mark it unverified.

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
| qa-lead | `qa-journeys/checklists/journey-checks.md`, `test-layers.md`; `ux-review/checklists/ux-heuristics.md` |

When your skill says to use one, copy it and fill in **every row** (verdict and evidence),
then check it is complete:

```bash
python3 $SHARED_DIR/skills/_team/working-agreements/scripts/checklist.py start <checklist> --out <your-report-folder>/checklists/YYYY-MM-DD-<name>.md
python3 $SHARED_DIR/skills/_team/working-agreements/scripts/checklist.py summary <your-report-folder>/checklists/YYYY-MM-DD-<name>.md   # exits 1 until complete
```

Every `missing` or `fail` row is a finding in your report. Paste the summary into the report.
A review whose checklist is incomplete says so; it does not conclude. If an item should be on
your checklist and isn't, propose it in your report.

