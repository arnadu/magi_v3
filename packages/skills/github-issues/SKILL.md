---
name: github-issues
description: |
  View, create, and update GitHub Issues in the MAGI repository.
  Use to surface bugs, limitations, and deferred improvements discovered during a mission.
---

# GitHub Issues

Report bugs and track improvements in the MAGI GitHub repository.

## Who can use this

**Agents on a mission cannot run these scripts**: they need a `GH_TOKEN`, and mission
machines never hold one by design. Do not ask anyone for a token. To report a platform
bug, message the mission copilot with what you observed and the evidence; it searches
existing issues (`ListGithubIssues`) and proposes one (`ReportGithubIssue`), which the
operator confirms in the cockpit before anything is posted.

**Copilots** use their built-in tools instead of these scripts: the control-plane copilot
has `ListIssues`, `CreateIssue`, `CloseIssue` and `AddIssueComment`, the mission copilot
`ListGithubIssues` and `ReportGithubIssue`. Every GitHub write is confirmed by the operator.

The scripts below are for a local developer environment where `GH_TOKEN` and
`GITHUB_REPO` are already set.

## Usage

### List open issues

```bash
bash <platform-skills-path>/github-issues/scripts/list-issues.sh [label]
```

Omit label to list all open issues. Common labels: `bug`, `enhancement`, `deferred`, `ux`.

### Create an issue

```bash
bash <platform-skills-path>/github-issues/scripts/create-issue.sh \
  "<title>" \
  "<body — markdown, use \n for newlines>" \
  "label1,label2"
```

### Add a comment to an issue

```bash
bash <platform-skills-path>/github-issues/scripts/add-comment.sh <issue-number> "<comment>"
```

### Close an issue

```bash
bash <platform-skills-path>/github-issues/scripts/close-issue.sh <issue-number> "<closing reason>"
```

## Label conventions

| Label | Use for |
|-------|---------|
| `bug` | Something that does not work as expected |
| `enhancement` | Improvement to existing functionality |
| `deferred` | Known gap, accepted for now, queued for a future sprint |
| `ux` | User-visible presentation or interaction issue |
| `security` | Security finding or hardening opportunity |

## Good issue body structure

```
**Observed:** <what currently happens>
**Expected:** <what should happen>
**Impact:** <consequence of the bug or gap>
**Proposed fix:** <implementation sketch — optional but helpful>
**First seen:** <sprint or commit, if known>
```
