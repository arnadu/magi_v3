---
name: github-issues
description: |
  View, create, and update GitHub Issues in the MAGI repository.
  Use to surface bugs, limitations, and deferred improvements discovered during a mission.
---

# GitHub Issues

Report bugs and track improvements in the MAGI GitHub repository.

## Requirements

`GH_TOKEN` and `GITHUB_REPO` must be in the environment:

```bash
export GH_TOKEN=<personal-access-token-with-repo-scope>
export GITHUB_REPO=arnadu/magi_v3
```

**Copilot agents** use the built-in `ListIssues`, `CreateIssue`, `CloseIssue`, and
`AddIssueComment` tools instead of these scripts — they run in-process with automatic
token injection.

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
