---
name: repo-workspace
description: Keep your own read-only clone of the mission's repository current, list the commits since your review cursor with a first triage, and move the cursor. Used by every reviewer on this team.
---

# Repository workspace

The repository this mission works on is listed in `$SHARED_DIR/team/repositories.json`
(name, URL, branch, clone location). That file is part of the mission configuration: read it,
never edit it. Nothing about the repository is hardcoded in a skill.

Every reviewer keeps **its own clone** inside its own working directory (`$WORKDIR/repos/...`), so no teammate can
change what you are reading. You never push, commit or open pull requests from it.

## Scripts

`S=$SHARED_DIR/skills/_team/repo-workspace/scripts` (in Bash, `$SHARED_DIR`, `$WORKDIR` and `$AGENT_ID` are always set)

| Step | Command | What it does |
|---|---|---|
| Sync | `bash $S/repo-sync.sh` | Clones on first use, otherwise fetches and checks out the branch head (detached). Prints the clone path and the head commit |
| Your cursor | `python3 $S/cursor.py get` | The last commit you fully reviewed |
| Commits to review | `python3 $S/commits-since.py <clone> <cursor> --lens security\|code\|docs` | Oldest first, each with its changed files marked `deep`, `skim` or `skip` for your lens; at most 60 commits per call |
| Move your cursor | `python3 $S/cursor.py set <sha> "<note>"` | Only after the report covering that commit is written |
| See everyone's cursor | `python3 $S/cursor.py show` | What each reviewer has covered |
| CI result | `python3 $S/ci-status.py <sha> [...]` | green / red / pending / no-ci per commit, from GitHub's public API (60 requests an hour without a credential) |

The cursors live in `$SHARED_DIR/reports/review-cursor.json`, one entry per agent.

## Rules

- **The triage is a hint, not a verdict.** A file marked `skip` can still matter (a test that
  was deleted, a doc that now contradicts the code). Read the commit message and decide.
- **Move the cursor only past what you reviewed.** If you stop part-way through a long range,
  set the cursor to the last commit you finished and say so in the report.
- **Large ranges**: review in batches of the 60 the script prints, writing one report per batch.
- **No dependencies installed.** Don't run `npm install` or `npm ci` in the clone; `npm audit`
  works from `package-lock.json` alone.
- **Reading code**: `git -C <clone> show <sha>`, `git -C <clone> log -p -- <path>`, and the
  Read and Bash tools on files in the clone. `grep -rn` across the clone for variants.
