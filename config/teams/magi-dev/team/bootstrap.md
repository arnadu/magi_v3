# MAGI DEV phase 0 — setup for the mission copilot

The user asks you (the mission copilot) to apply this file once, right after launch. Do the
three steps in order, then PostMessage the user a summary: the objective count, the task ids,
and the schedule labels with their next delivery times. If something fails, report what and why
rather than improvising.

Before step 1, call ReadMissionObjectives: if objectives already exist, stop and ask the user,
because EditObjectiveTree replaces the whole tree.

## 1. Objectives — EditObjectiveTree with exactly this array

Budgets are placeholders; the user sets them later.

```json
[
  {"id":"SEC","parent":null,"title":"MAGI is secure by design","owner":"appsec","status":"active","budgetUsd":20,
   "kpis":[
     {"id":"K-sec-open-high","label":"open CRITICAL and HIGH findings","owner":"appsec","kind":"quantitative","source":"agent-reported","target":0},
     {"id":"K-sec-cost","label":"spend","owner":"appsec","kind":"quantitative","source":"auto-stat","metricKey":"objectiveCostUsd","target":20,"unit":"USD"}]},
  {"id":"SEC-1","parent":"SEC","title":"Change assurance: every change to main is security-reviewed promptly","owner":"appsec","status":"active",
   "kpis":[
     {"id":"K-sec1-lag","label":"days since the oldest unreviewed commit","owner":"appsec","kind":"quantitative","source":"agent-reported","target":1,"unit":"days"},
     {"id":"K-sec1-share","label":"share of commits reviewed","owner":"appsec","kind":"quantitative","source":"agent-reported","target":100,"unit":"%"}]},
  {"id":"SEC-2","parent":"SEC","title":"Findings management: the register is current and every finding is tracked to a verified fix","owner":"appsec","status":"active",
   "kpis":[
     {"id":"K-sec2-age","label":"median age of open HIGH findings","owner":"appsec","kind":"quantitative","source":"agent-reported","target":14,"unit":"days"},
     {"id":"K-sec2-verified","label":"share of closed findings with a verified fix","owner":"appsec","kind":"quantitative","source":"agent-reported","target":100,"unit":"%"}]},
  {"id":"SEC-3","parent":"SEC","title":"Security knowledge base: threat model, trust boundaries, findings tracker and practices match the code","owner":"appsec","status":"active",
   "kpis":[
     {"id":"K-sec3-boundaries","label":"trust boundaries reviewed in depth in the last 26 weeks","owner":"appsec","kind":"quantitative","source":"agent-reported"},
     {"id":"K-sec3-accuracy","label":"accuracy of the security documents","owner":"appsec","kind":"qualitative","source":"manual","rubric":"Would a new engineer be misled by them?"}]},
  {"id":"SEC-4","parent":"SEC","title":"Supply chain: no known HIGH or CRITICAL advisory in production dependencies","owner":"appsec","status":"active",
   "kpis":[
     {"id":"K-sec4-open","label":"open HIGH or CRITICAL production advisories","owner":"appsec","kind":"quantitative","source":"agent-reported","target":0},
     {"id":"K-sec4-lag","label":"days from a published advisory to its report","owner":"appsec","kind":"quantitative","source":"agent-reported","target":2,"unit":"days"}]},
  {"id":"SEC-5","parent":"SEC","title":"Secure design: planned work gets security requirements before it is built","owner":"appsec","status":"active",
   "kpis":[
     {"id":"K-sec5-usefulness","label":"usefulness of design reviews","owner":"appsec","kind":"qualitative","source":"manual","rubric":"Did the review change the design for the better?"}]},
  {"id":"SEC-6","parent":"SEC","title":"Monitoring and audit design (design only)","owner":"appsec","status":"active",
   "kpis":[{"id":"K-sec6-specs","label":"specifications delivered","owner":"appsec","kind":"quantitative","source":"task-rollup"}]},
  {"id":"SEC-7","parent":"SEC","title":"Security planning and budget: a costed security backlog","owner":"appsec","status":"active",
   "kpis":[{"id":"K-sec7-backlog","label":"planning tasks done","owner":"appsec","kind":"quantitative","source":"task-rollup"}]},
  {"id":"CODE","parent":null,"title":"Every change to main is reviewed for correctness and maintainability","owner":"code-reviewer","status":"active","budgetUsd":15,
   "kpis":[
     {"id":"K-code-lag","label":"days since the oldest unreviewed commit","owner":"code-reviewer","kind":"quantitative","source":"agent-reported","target":1,"unit":"days"},
     {"id":"K-code-precision","label":"usefulness of findings","owner":"code-reviewer","kind":"qualitative","source":"manual","rubric":"Share of findings the user judged real and worth fixing"},
     {"id":"K-code-cost","label":"spend","owner":"code-reviewer","kind":"quantitative","source":"auto-stat","metricKey":"objectiveCostUsd","target":15,"unit":"USD"}]},
  {"id":"DOCS","parent":null,"title":"The documentation is consistent with the code","owner":"documenter","status":"active","budgetUsd":10,
   "kpis":[
     {"id":"K-docs-lag","label":"days since the oldest unchecked commit","owner":"documenter","kind":"quantitative","source":"agent-reported","target":2,"unit":"days"},
     {"id":"K-docs-open","label":"open inconsistencies reported and not yet fixed","owner":"documenter","kind":"quantitative","source":"agent-reported"},
     {"id":"K-docs-cost","label":"spend","owner":"documenter","kind":"quantitative","source":"auto-stat","metricKey":"objectiveCostUsd","target":10,"unit":"USD"}]}
]
```

## 2. Initial tasks — AddTask, one call each, passing the `id` shown

Create only the tasks listed here. If an id is already taken, don't renumber silently: use the
next free id and list every renumbering (`CR-03 → CR-05`) in your summary to the user, because
the user refers to tasks by these ids.

| id | objective | assignee | title |
|---|---|---|---|
| T-01 | SEC | appsec | Onboard: clone the repository, read the security documents, practices and ADRs, write your system-model notes, set your review cursor (skill appsec-onboarding) |
| T-02 | SEC-2 | appsec | Baseline register: import the open findings of docs/security/findings.md and the open security-labelled issues, with your assessment of each |
| T-03 | SEC-1 | appsec | First change review: the commits from your initial cursor to HEAD, then move the cursor |
| T-04 | SEC-4 | appsec | Supply-chain baseline: advisory triage of production and development dependencies |
| T-05 | SEC-5 | appsec | Design review of docs/plans/magi-dev-requirements.md: production access (A), gateway (G), governance engine (E), egress (H), source control (B); a verdict and security requirements per deliverable |
| T-06 | SEC-3 | appsec | First drift sweep: compare the security documents (threat model, trust boundaries, findings tracker) with the code |
| T-07 | SEC-6 | appsec | Audit and detection requirements for A, E and G: what each must log, the audit record's fields, which events raise an alert |
| T-08 | SEC-7 | appsec | Costed security backlog from the register and the roadmap's security items |
| T-09 | SEC | appsec | First weekly summary to the user |
| CR-01 | CODE | code-reviewer | Onboard: clone, read the CLAUDE.md files and docs/practices, set your review cursor |
| CR-02 | CODE | code-reviewer | First change review: the commits from your initial cursor to HEAD |
| DC-01 | DOCS | documenter | Onboard: clone, read the documentation map (README, spec, user guide, docs/), set your review cursor |
| DC-02 | DOCS | documenter | First check of the commits from your initial cursor to HEAD |
| DC-03 | DOCS | documenter | First sweep: USER_GUIDE.md and the security documents |

## 3. Schedules — CreateScheduledMessage, one call each (cron in UTC)

Staggered so two reviewers never start on the same commits at the same time.

| label | to | cron | subject | body |
|---|---|---|---|---|
| appsec-change-review | appsec | `0 */6 * * *` | Change review | Run change-review on the commits since your cursor (SEC-1). If onboarding (T-01) isn't finished, continue onboarding instead. |
| appsec-weekly | appsec | `0 7 * * 1` | Weekly security duties | Weekly: advisory-triage; drift check of the security documents; one trust boundary in depth; then the weekly summary to the user. |
| appsec-monthly | appsec | `0 8 1 * *` | Monthly security duties | Monthly: review the register and update every KPI you own; refresh the security backlog estimates (SEC-2, SEC-7). |
| code-review | code-reviewer | `0 3,9,15,21 * * *` | Code review | Run code-review on the commits since your cursor. If onboarding (CR-01) isn't finished, continue it instead. |
| docs-check | documenter | `0 5 * * *` | Documentation check | Run doc-consistency on the commits since your cursor. If onboarding (DC-01) isn't finished, continue it instead. |
| docs-sweep | documenter | `0 6 * * 3` | Documentation sweep | Weekly sweep of the next area in your rotation (doc-consistency, sweep mode); then a short PostMessage to the user. |

## Addendum 2026-11-11 — code reviewer, wave 1

Apply only this section if the steps above were already applied. AddTask, passing the `id`
shown; if an id is taken, use the next free one and report the mapping to the user:

| id | objective | assignee | title |
|---|---|---|---|
| CR-03 | CODE | code-reviewer | First rules-enforcement audit: build the rules matrix (skill rules-enforcement-audit) |
| CR-04 | CODE | code-reviewer | First hotspot analysis and weekly report; choose the first module for a deep review |

CreateScheduledMessage:

| label | to | cron | subject | body |
|---|---|---|---|---|
| code-weekly | code-reviewer | `0 8 * * 2` | Weekly code health | Run hotspot-analysis and write the weekly report (top hotspots and change since last week, the module recommended for a deep review). |
| code-monthly | code-reviewer | `0 9 2 * *` | Monthly rules audit | Run rules-enforcement-audit: update the rules matrix and write the report with enforcement proposals. |

## Addendum 2026-11-13 — qa-lead, and checklists for everyone

Apply only this section if the earlier ones were already applied.

**1. Objectives.** EditObjectiveTree replaces the whole tree: call ReadMissionObjectives first,
keep every existing objective unchanged, add this one, and save the complete list.

```json
{"id":"QA","parent":null,"title":"Every operator journey works end to end, is quick, keeps the operator informed, and is tested","owner":"qa-lead","status":"active","budgetUsd":10,
 "kpis":[
   {"id":"K-qa-journeys","label":"journeys reviewed in the last 8 weeks","owner":"qa-lead","kind":"quantitative","source":"agent-reported","target":17},
   {"id":"K-qa-tested","label":"journeys with an end-to-end test","owner":"qa-lead","kind":"quantitative","source":"agent-reported","target":17},
   {"id":"K-qa-live-bugs","label":"bugs found by the operator in live use, last 30 days","owner":"qa-lead","kind":"quantitative","source":"agent-reported","target":0},
   {"id":"K-qa-cost","label":"spend","owner":"qa-lead","kind":"quantitative","source":"auto-stat","metricKey":"objectiveCostUsd","target":10,"unit":"USD"}]}
```

**2. Tasks.** AddTask, passing the `id` shown; if an id is taken, use the next free one and
report the mapping to the user.

| id | objective | assignee | title |
|---|---|---|---|
| QA-01 | QA | qa-lead | Onboard: clone, read docs/plans/scenario-test-harness.md, the cockpit's screens, the copilots' tools, actions, prompts and skills; build your journey rotation |
| QA-02 | QA | qa-lead | Journey review J-02 (create a mission from a request) at commit f4eb26d, in a worktree, then at HEAD; report both and the difference |
| QA-03 | QA | qa-lead | Test layers: fill the test-layers checklist for the repository as it is |
| QA-04 | QA | qa-lead | Where bugs are found: the bug fixes of the last 30 days and how each was found |
| QA-05 | QA | qa-lead | Usability review of the cockpit's draft editor and launch flow |
| SEC-T1 | SEC | appsec | First full pass of the security controls checklist, one area per weekly run until all areas are done |
| CR-T1 | CODE | code-reviewer | Use the change-completeness checklist on every commit read in depth from now on |
| DC-T1 | DOCS | documenter | First documentation coverage checklist |

**3. Schedules.** CreateScheduledMessage (cron in UTC):

| label | to | cron | subject | body |
|---|---|---|---|---|
| qa-weekly | qa-lead | `0 7 * * 4` | Weekly journey review | Review the next one or two journeys in your rotation with the journey checklist (qa-journeys), and write scenarios for those without a test. If onboarding (QA-01) isn't finished, continue it instead. |
| qa-monthly | qa-lead | `0 10 3 * *` | Monthly QA duties | Fill the test-layers checklist, review where the last 30 days' bugs were found, and do one usability review (ux-review). |
| docs-monthly | documenter | `0 10 4 * *` | Monthly documentation coverage | Fill the documentation coverage checklist (doc-consistency, "Coverage"). |

## Addendum 2026-11-16 — the scan

Apply only this section if the earlier ones were already applied. The reviewers now get a
"Scan to-do" region in their mental map, filled from `shared/analysis/` by a scheduled trace of
the repository against its baseline catalog (skill `trace-scan`).

**Tasks.** AddTask, passing the `id` shown; if an id is taken, use the next free one and report
the mapping to the user.

| id | objective | assignee | title |
|---|---|---|---|
| CR-T2 | CODE | code-reviewer | Set up the trace-scan job (skill trace-scan, "Setting up the job"), run it once now with submit-job.sh, and send the user the first scan's headline numbers from shared/analysis/index.md |
| SEC-T2 | SEC | appsec | Once the first scan is published: read "The trace" in docs/practices/traceability.md, then work through your Scan to-do (confirm, report, dispose) |
| CR-T3 | CODE | code-reviewer | Once the first scan is published: read "The trace" in docs/practices/traceability.md, then work through your Scan to-do (confirm, report, dispose) |
| DC-T2 | DOCS | documenter | Once the first scan is published: read "The trace" in docs/practices/traceability.md, then work through your Scan to-do (confirm, report, dispose) |
| QA-T2 | QA | qa-lead | Once the first scan is published: read "The trace" in docs/practices/traceability.md, then work through your Scan to-do (confirm, report, dispose) |

Then PostMessage code-reviewer: "CR-T2 is assigned to you: set up and run the trace-scan job
now." No schedule to create: the code reviewer creates the scan's own schedule as part of CR-T2.

## Addendum 2026-11-17 — when a scan task is done

Apply only this section if the earlier ones were already applied.

- A scan task (SEC-T2, CR-T3, DC-T2, QA-T2) is done when the assignee's
  `shared/analysis/todo-<agent>.md` shows `Open: 0` and `deferred: 0`. Read that file to decide;
  an agent's own notes are not evidence. Reopen any of these tasks marked done whose file still
  shows open or deferred findings, and tell its assignee why.
- A decision only counts with evidence for that finding (skill `trace-scan`). The to-do marks a
  decision that does not count, and says why.
- When a reviewer finds the code right and the catalog wrong, it records `catalog`; those are
  listed in `shared/analysis/catalog-questions.md`. Include their number, and any new ones, in
  your daily report to the user.

## Addendum 2026-11-18 — the code reviewer's trial

Apply only this section if the earlier ones were already applied.

- The code reviewer is on a trial: its role is now described by goals (code that is easy and
  safe to change, and how its work is judged) rather than by procedures. The scan's
  `status.undeclared-transition` findings move from the code reviewer to the QA lead. Its scan task CR-T3 is not judged by
  how many findings it closes; do not chase it, reopen it or report on its count. Mark CR-T3
  `in-progress` if it is marked done.
- Every to-do now lists the findings first and ends with a summary line, "Not yet examined: N
  … Deferred: N. Concluded: N." For the other reviewers, a scan task is done when that line
  shows nothing left to examine and nothing deferred.


## Addendum 2026-11-18 (2) — the trace as leads

Apply only this section if the earlier ones were already applied. It replaces the rules about
scan tasks in the two addenda above.

- The trace's findings are now leads for each reviewer's reviews, not a list to clear. Each
  reviewer's mental map shows a "Trace findings" region (what is new, and what it has
  concluded) in place of the "Scan to-do"; nothing counts the findings left to examine.
- Close the scan tasks SEC-T2, CR-T3, DC-T2 and QA-T2 with the note "superseded 2026-11-18: the
  trace's findings are leads, not a list". Do not chase, reopen or report on how many findings
  a reviewer has examined.
- The user checks a sample of the reviewers' dismissals against the code. In your daily report,
  give each reviewer's line "Your conclusions on this scan: …" from
  `shared/analysis/findings-<agent>.md` (findings raised, catalog questions), and the number of questions in `shared/analysis/catalog-questions.md`.
- PostMessage appsec, code-reviewer, documenter and qa-lead: "The trace's findings are now
  leads for your reviews, not a list to clear (see 'The trace' in your instructions). Remove
  from your mental map any conclusions about trace findings that you did not verify one
  finding at a time against the code."

## Addendum 2026-11-18 (3) — reporting on the trace

Apply only this section if the earlier ones were already applied.

- In your daily report, the line from each `shared/analysis/findings-<agent>.md` is now "Your
  conclusions on this scan: …". Report the findings raised and the catalog questions; do not
  report or comment on the number of dismissals. The user takes up a wrong dismissal with its
  reviewer directly.
- The command that records a conclusion on a finding is now `decisions.mjs record` (it was
  `dispose`).

## Addendum 2026-11-22 — appsec's work list and red team

Apply only this section if the earlier ones were already applied. appsec's change review now
fills a generated work list (every changed entry point crossed with the controls that apply to
it), and a separate weekly turn attacks one trust boundary (skill `red-team`).

**Task.** AddTask, passing the `id` shown; if the id is taken, use the next free one and report
the mapping to the user.

| id | objective | assignee | title |
|---|---|---|---|
| SEC-T3 | SEC-1 | appsec | First red-team pass (skill red-team): the interactive apps boundaries TB-23, TB-24, TB-25 and TB-26 at commit 16bba51, in a worktree, one boundary per red-team turn in that order |

**Schedule.** CreateScheduledMessage (cron in UTC):

| label | to | cron | subject | body |
|---|---|---|---|---|
| appsec-red-team | appsec | `0 13 * * 1,4` | Red-team turn | Run red-team on one boundary: SEC-T3's next boundary while it is open, then the oldest line of your red-team queue, otherwise the next boundary in your rotation. Do not mix it with a change review in the same turn. |

Then PostMessage appsec: "SEC-T3 is assigned to you; your first red-team turn is the next
scheduled one."

## Addendum 2026-11-23 — the report gate; appsec, the code reviewer and the QA lead paused

Apply only this section if the earlier ones were already applied. Reports are now checked by a
scheduled job, `report-gate` (code, not an agent): a report with a reference the repository does
not have is rejected and sent back to its author (`working-agreements`, rule 9). The security
review is being redesigned (`docs/plans/security-assurance-plan.md` in the repository): until
then **appsec, code-reviewer and qa-lead are paused**. The operator has cancelled their
schedules; do not re-create them, do not message those three, and do not assign them tasks.
Their open tasks stay as they are.

**The gate's schedule** runs as the documenter, whose clone it uses. PostMessage documenter:

"Please run this once, exactly as written, then reply with its output:

```bash
bash "$SHARED_DIR/skills/_platform/run-background/scripts/schedule-job.sh" \
  --label report-gate --cron '15 * * * *' \
  --script "$SHARED_DIR/skills/_team/working-agreements/scripts/report-gate.sh" \
  --args "$SHARED_DIR $WORKDIR"
```

It schedules the report gate, which checks every new or changed report hourly. appsec,
code-reviewer and qa-lead are paused: send anything you would hand to them to the user instead."

When the documenter replies, check with ListScheduledMessages that `report-gate` is pending, and
tell the user its next run time. The gate's results are in `reports/gate/ledger.md`.

## Addendum 2026-11-26 — appsec returns, on alert triage

Apply only this section if the earlier ones were already applied, and only once the mission runs
the image with work-order tasks (ADR-0038): `AddTask` must accept `instructions`, `doneWhen`,
`check` and `skills`. If it does not, stop and tell the user. Before this, the operator has
replaced appsec's system prompt and its mental map.

appsec returns with a new role: it triages the repository's security alerts and re-reviews the
watched guards through the review pipeline, verifies what survives, and keeps the register. Its
commit-by-commit review, red team, drift sweeps and design work are paused: their objectives go
back to `proposed` until the user reactivates them.

**Objectives.** Call ReadMissionObjectives, then EditObjectiveTree with the same tree, changing
only appsec's branch (SEC and its children) as follows. Keep every other objective, and every
KPI not named here, exactly as it is.
- SEC: add the description "Secure by design, and the user always knows, with evidence, where
  MAGI's security stands. appsec is the named reader of the security checks that only report."
- SEC-4: title "Every security signal gets a verdict appsec checked", description "Each open
  code-scanning and Dependabot alert, and each watched guard, is examined by the review pipeline
  (skill alert-triage) and, where the pipeline could not dismiss it, by appsec reading the
  code." KPIs: keep `K-sec4-open` with the label "verified HIGH or CRITICAL alerts still open"
  (target 0); remove `K-sec4-lag`; add
  `{"id":"K-sec4-untriaged","label":"open security alerts without a verdict","owner":"appsec","kind":"quantitative","source":"agent-reported","target":0}`.
- SEC-2: description "The findings register tells the truth: a real issue is in it with its
  evidence; a fixed one is marked fixed only after appsec read the fix; a dismissed one says
  why, with the code that shows it." Add the KPI
  `{"id":"K-sec2-held","label":"share of pipeline findings that held when verified","owner":"appsec","kind":"quantitative","source":"agent-reported","unit":"%"}`.
- New SEC-8, parent SEC, owner appsec, status active: title "The user knows the security
  state", description "A new HIGH or CRITICAL is mailed at once; a weekly summary gives the
  runs, the findings verified and dismissed, and what needs a decision, every number with its
  source; what could not be established is reported as unknown (skill security-reporting)."
  No KPI.
- New SEC-9, parent SEC, owner appsec, status active: title "The checks get better",
  description "Where the pipeline or a scanner errs, appsec says so with the evidence (item
  ids, ledger reasons) and proposes the change; it never does a broken check's job by hand."
  KPI `{"id":"K-sec9-errors","label":"rejected or failed items in the last triage run","owner":"appsec","kind":"quantitative","source":"agent-reported","target":0}`.
- SEC-1, SEC-3, SEC-5, SEC-6 and SEC-7: status `proposed`, each with the description "Paused
  2026-11-26 until the review pipeline supports this work; the user reactivates it."

**KPIs.** RecordKpi `K-sec-open-high` and `K-sec4-open` with the value `unknown` and the note
"2026-11-26: the earlier 0 came from npm audit and appsec's own reviews; the scanners report
open alerts at these severities, unverified until the first triage pass (SEC-T6)".

**Tasks.** UpdateTask to `cancelled`, each with its note:
- T-10: "Cancelled 2026-11-26: recurring work is not a task. Change review returns, as a
  pipeline kind, when the user reactivates SEC-1."
- SEC-T1: "Cancelled 2026-11-26: the controls checklist returns as a pipeline kind."
- SEC-T3: "Cancelled 2026-11-26: TB-23 done (report 2026-11-23-red-team-tb23.md); TB-24, TB-25
  and TB-26 remain for when red team returns."

Then AddTask, one call each, with exactly these fields (assignee `appsec`; if an id is taken,
use the next free one and report the mapping).

SEC-T5 · objective SEC-4 · priority high · title "Schedule the daily alert-triage job and run
it once now"
- instructions: "Follow skill alert-triage, 'Schedule the job (once)': schedule run_triage.sh
  daily at 06:00 UTC, notifying you when each run finishes. Then start the same script once now
  as a background job (skill run-background) rather than waiting for 06:00. Reply to the user
  with both commands' output. The run wakes you with 'Alert triage run finished'."
- doneWhen: "shared/schedules/alert-triage.json runs alert-triage/scripts/run_triage.sh and
  notifies you, and at least one run has finished in your review/state/runs/."
- check: `{"script":"alert-triage/scripts/check_triage.sh","args":["scheduled"]}`
- skills: `["alert-triage","run-background"]`

SEC-T6 · objective SEC-4 · priority high · title "First triage pass: verify what the pipeline
found until the backlog is through"
- instructions: "After each run ('Alert triage run finished'), follow skill alert-triage, 'After
  a run': read the newest review/state/runs/<stamp>/summary.json and findings.json, verify each
  finding by reading the code in the reference copy, and record it in the register (skill
  findings-register), as a finding or as dismissed, with its item id and run stamp. Each daily
  run first takes up what the last one deferred. Mail a new HIGH or CRITICAL to the user at once
  (skill security-reporting). Report repeated rejected or failed items; never investigate them
  yourself instead."
- doneWhen: "The newest run deferred no item, and every finding of every run is in
  shared/reports/security/register.md by its item id, verified or dismissed."
- check: `{"script":"alert-triage/scripts/check_triage.sh","args":["first-pass"]}`
- skills: `["alert-triage","security-judgement","findings-register"]`

SEC-T7 · objective SEC-2 · title "Review the findings register against the current code"
- instructions: "Follow skill findings-register, 'Monthly review', for
  shared/reports/security/register.md, against the reference copy at its current commit
  (/var/lib/magi/reference/magi-v3/status.json). Start with MD-001 to MD-004, imported on
  2026-11-10 from F-022, F-026, F-029 and F-031: check each against docs/security/findings.md
  and the code. Then update the findings summary in your mental map."
- doneWhen: "Every register entry not at an end state carries today's date in its History with
  what was checked, and your mental map's findings summary matches the register."
- skills: `["findings-register","security-judgement"]`

SEC-T8 · objective SEC-2 · title "Mark your three unestablished reports as superseded"
- instructions: "Three of your reports state that no HIGH or CRITICAL issue was open, which was
  never established: shared/reports/security/2026-11-10-change-review.md,
  2026-11-10-advisory-triage.md and 2026-11-11-security-backlog.md. Add one line at the top of
  each: 'Superseded 2026-11-26: its conclusion that no HIGH or CRITICAL issue was open was not
  established; see the alert triage (task SEC-T6).' Change nothing else."
- doneWhen: "Each of the three files begins with that line, and nothing else in them changed."
- skills: `["security-reporting"]`

**Schedules.** First cancel every schedule addressed to appsec that is still pending (from
the earlier sections: `appsec-change-review`, `appsec-weekly`, `appsec-monthly`,
`appsec-red-team`). Then CreateScheduledMessage (cron in UTC):

| label | to | cron | subject | body |
|---|---|---|---|---|
| appsec-weekly | appsec | `0 7 * * 1` | Weekly summary | Write and send the weekly summary (skill security-reporting, "The weekly summary"). |
| appsec-monthly | appsec | `0 8 1 * *` | Monthly register review | Review the findings register (skill findings-register, "Monthly review"). |

**Then PostMessage appsec** (subject "Your role has changed"), exactly:

"Your role has changed: read your system prompt and your mental map, both rewritten on
2026-11-26; trust them over anything earlier. Your work is in 'Your objectives', each task with
its instructions, finish line and the skills it must follow. Start SEC-T5; do SEC-T8 and SEC-T7
while the first triage run works; SEC-T6 when it finishes."

Report to the user what you changed, with the task ids as created.
