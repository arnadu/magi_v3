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
