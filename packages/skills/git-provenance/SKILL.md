---
name: git-provenance
description: |
  Record completed work with a git commit and ledger entry.
  Use when you have finished writing or updating a file that should be tracked.
---

# Git Provenance

Record your work in the mission git repository so the team has a complete
audit trail. The shared folder is already a git repository — do not run
`git init`.

## Usage

Run the record-work script, passing your agent id, the commit message, and
the file(s) you want to stage and commit:

```bash
bash <platform-skills-path>/git-provenance/scripts/record-work.sh \
  "<agent-id>" \
  "<type>(<label>): <description> [sources: <url-or-none>]" \
  "<absolute-path-to-file1>" "<absolute-path-to-file2>" ...
```

**Commit message format:** `type(label): description [sources: url]`
- `type`: `feat`, `fix`, `docs`, `data`, `analysis`, `report`
- `label`: short identifier for the output (e.g. `report`, `analysis-aapl`)
- `sources`: comma-separated source URLs, or `none`

**Example:**
```bash
bash /missions/my-mission/shared/skills/_platform/git-provenance/scripts/record-work.sh \
  "worker" \
  "report(pdf-analysis): formal analysis of Q4 memo [sources: none]" \
  "/missions/my-mission/shared/report.md"
```

## Ledger

The script also appends a structured entry to `ledger.jsonl` in the shared
folder root for machine-readable querying:

```bash
cat /missions/my-mission/shared/ledger.jsonl | jq 'select(.agent == "worker")'
```
