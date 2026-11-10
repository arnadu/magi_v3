---
name: findings-register
description: The mission's security findings register — MD-NNN ids, the entry format, the life-cycle from new to verified fixed, de-duplication against the official tracker, and how fixes are verified.
---

# Findings register

The register is `$SHARED_DIR/reports/security/register.md`, owned by you (`appsec`). It is the
mission's record of every finding and its status. The official tracker in the repository
(`docs/security/findings.md`) is separate: a finding gets an official `F-NNN` id only when the
user accepts it into the repository, so the two numbering schemes never collide.

## Ids

`MD-NNN`, three digits, sequential, never reused. Find the next id with
`grep -o 'MD-[0-9]\{3\}' register.md | sort | tail -1`.

## Entry format

One section per finding:

```markdown
### MD-007 · HIGH · new — <short title>
- **Where:** <path/to/file.ts:NN>
- **Found:** 2026-11-10, change review a07bd72..b12c3d4 (report 2026-11-10-change-review.md)
- **Path:** <who controls what, how it reaches the sink, what it achieves>
- **Refutation attempted:** <what you checked>
- **Fix proposed:** <specific change>
- **Official:** — (or F-079 once accepted)
- **History:** 2026-11-10 new · 2026-11-11 reported · ...
```

## Life-cycle

`new` → `reported` (in a report the user has received) → `accepted` (user took it into the
repository; record the `F-NNN`) → `fix proposed` → `fixed, verified` (you saw the fix in a later
commit and checked it).

Other ends: `accepted risk` (the user decided not to fix; record the rationale and where it is
written), `false positive` (record why, and add a lesson to your mental map), `duplicate of
MD-NNN` or `duplicate of F-NNN`.

## Rules

- **De-duplicate before adding.** Search the register and the official tracker for the file and
  the pattern.
- **Verify fixes yourself.** When a commit claims to fix a finding (or the user tells you),
  read the fix at your next review: does it close the path you described, and its variants? Is
  there a test that fails without it? Only then mark `fixed, verified`, naming the commit.
- **Keep the summary current.** After every change to the register, update the findings summary
  in your mental map (counts by severity and status, the top open items), and the KPIs you own.
- The register is private to the mission. Never copy an unfixed finding anywhere public.

## Importing the official tracker (onboarding)

For each open row of `docs/security/findings.md`, add an entry with status `reported`, the
`F-NNN` in **Official**, and your own one-line assessment of whether it still applies to the
current code. Also list open GitHub issues labelled `security` (read them at
`https://github.com/<owner>/<repo>/issues?q=is%3Aopen+label%3Asecurity` with FetchUrl).
