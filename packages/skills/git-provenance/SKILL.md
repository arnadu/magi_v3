---
name: git-provenance
description: |
  How the mission keeps an audit trail of your work. Your files are committed
  to git automatically — you do not need to commit anything yourself.
---

# Git Provenance

The shared mission folder is a git repository, and the system **automatically
commits it at the end of every turn**. Any file you create or change there — via
`WriteFile`, `EditFile`, `Bash`, or a skill script — is captured in that
checkpoint without any action from you.

## What this means for you

- **Just write your work** to the shared folder. Use clear, stable file paths.
- **Do not run `git init`, `git add`, or `git commit`** — the daemon owns all
  commits. Manual commits would interleave with the automatic checkpoint and can
  collide on the git lock.
- Each checkpoint's commit hash and changed-file list are recorded in the
  mission's turn statistics, so the operator can later retrieve any version of a
  file (`git show <hash>:<relPath>`) and see exactly when it changed.

That's it. Concentrate on producing good work products in the shared folder; the
provenance trail is maintained for you.
