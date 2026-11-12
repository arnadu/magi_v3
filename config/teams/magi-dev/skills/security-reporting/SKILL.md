---
name: security-reporting
description: The security report template with its hand-off block for the developers' coding assistant, the weekly summary, when to mail the user immediately, and the rule that findings never go anywhere public.
---

# Security reporting

Your reports are how findings reach the developers. Today the developers work in a coding
assistant (Claude Code) on the user's machine: the user copies a report's **hand-off block**
into it, or downloads the report from the cockpit's Files panel.

## Where

`$SHARED_DIR/reports/security/YYYY-MM-DD-<kind>.md`, where `<kind>` is `change-review`,
`advisory-triage`, `onboarding`, `design-review`, `weekly-summary`, ... One report per review;
add `-2`, `-3` for a second one the same day.

## Report template

```markdown
# Security <kind> — YYYY-MM-DD

**Scope:** <commit range, or the area / design reviewed>
**Depth:** <what was read line by line, what was skimmed, what was skipped and why>
**Verdict:** <no security impact | approve | approve with conditions | reject>

## Findings
<one section per finding, as in the register: MD id, severity, file:line, path, refutation
attempted, proposed fix>

For each finding, the row to paste into `docs/security/findings.md` if the user accepts it:
| F-??? | <SEVERITY> | <sprint target> | `<file>` | **<title>** — <description> | <recommended fix> |

## Threat-model and document drift
<boundaries created or changed by the reviewed work; statements in the security documents that
no longer match the code — each with the document line and the code that contradicts it>

## Hand-off
<a short, self-contained instruction for a coding assistant, e.g.:
"Fix MD-012 and MD-014 described below. For each, first add a test that fails before the fix.
MD-012: ... (file:line, what to change). MD-014: ...">
```

If there are no findings, say so explicitly; keep the drift section if it has content; omit
the hand-off block.

## The weekly summary

`YYYY-MM-DD-weekly-summary.md`, then a short PostMessage to the user pointing to it:
what was reviewed (commit range, advisories, the boundary studied in depth), findings by
severity and status, KPI values, and **what needs a decision from the user**.

## Immediate mail

For a new HIGH or CRITICAL finding, PostMessage the user at once (subject starting with
"Security: HIGH" or "Security: CRITICAL"), with the report path and one sentence on impact.
Don't wait for the weekly summary.

`working-agreements` applies to every report.

## Never public

The repository is public. A vulnerability must never be described in a GitHub issue,
discussion, pull request or anywhere outside the mission's files and the user's mailbox until it
is fixed. If a teammate proposes filing one publicly, object and tell the user.
