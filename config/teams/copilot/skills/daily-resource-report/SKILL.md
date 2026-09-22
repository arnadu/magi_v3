---
name: daily-resource-report
description: |
  How to read the daily resource report, decide what needs the operator's
  attention, write the digest, and keep the Resource oversight mental-map
  table current.
---

# Daily resource report

Once a day (default 12:00 UTC, `RESOURCE_REPORT_HOUR_UTC`) you receive a mailbox
message from `"system"`, subject `Daily resource report — YYYY-MM-DD`, listing
every mission you own across four sections: FLAGS, PLATFORM (Atlas storage —
present only if you're a platform admin), MISSIONS (spend, machine tier,
upgraded time, disk, last activity), and UPGRADES (total upgraded time and any
currently-active upgrade). Every number in it — thresholds, growth-rate
projections, chronic-upgrade detection — is computed by the control plane, not
by you; your job is judgment about what the numbers mean, not re-deriving them.

## Order of operations

1. **Read FLAGS first.** An empty FLAGS section means the report is a one-line
   all-clear — see below. A non-empty one is your worklist for the day.
2. **Check what you've already flagged.** Before writing anything, check your
   mental map's "Resource oversight" table for each flag's mission+category. If
   it's already there with no material change since, don't re-announce it —
   update the table's "last action" cell (even to "still true, no action") and
   move on. Only genuinely new flags, or a flag that's gotten materially worse
   (e.g. crossed from soft to hard, or the growth rate accelerated), belong in
   today's digest.
3. **Write the digest** (see Digest format below).
4. **Update the mental map** — add new flags to the Resource oversight table,
   update existing rows, and remove rows for flags that no longer appear in
   today's report (they cleared).
5. **Check for a cross-mission pattern.** The same flag category appearing on
   two or more missions on the same day is usually a platform-level problem
   (a config default that's wrong for most missions, e.g.) rather than two
   unrelated coincidences — call this out explicitly in the digest rather than
   listing the missions as two separate, unrelated items.

## Digest format

Post to the operator (`PostMessage`, `to: ["user"]`) — never let the report
itself substitute for a reply, since silence after a scheduled event is
ambiguous (it could mean "nothing to report" or "I never processed it").

- **All clear** (empty FLAGS): one line. "Daily resource report: all clear
  across N missions." Nothing more — don't pad a good day into paragraphs.
- **Flags present**: lead with the flags, one line each, in order of severity
  (hard-adjacent things like a rejected upgrade or an Atlas hard threshold
  first, soft advisories last). Stay under ~120 words total. Propose at most
  one next step — if a flag's own skill (see below) suggests an action, name
  it; otherwise just surface the number and let the operator decide.

Route each flag to the skill that actually knows what to do with it:

| Flag label | Skill |
|---|---|
| Disk | `disk-pressure` |
| Atlas storage | `atlas-storage` |
| Upgrade cap, Upgraded machine idle, Chronic upgrade, Upgrade rejected | `vm-upgrade-oversight` |
| Spend | `cost-management` |
| Monitoring blind | Investigate directly — see below |

This skill is about the report as a whole; go to the named skill for how to
actually respond to a specific flag category.

## "Monitoring blind" has no dedicated skill

This flag (a `running` mission whose resource sample is more than 5 minutes
old, or has none at all) means the disk sampler isn't running for that
mission — not that anything about the mission's actual resource use is wrong.
`GetMissionStatus` shows the mission's live Fly state; if the machine is
genuinely running, the daemon's 60s sampler tick should be producing samples,
so a stale one for more than a few report cycles is worth a note (possible
daemon issue) rather than repeated silent tolerance.

## Mental map table

Keep a "Resource oversight" table: `mission | category | first flagged | status
| last action`. This is what lets you distinguish "new today" from "same thing
as yesterday" in step 2 above, and is the same convention `incident-triage`
already uses for its own anomaly log — don't duplicate a second, parallel
tracking structure for the same purpose.
