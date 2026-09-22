---
name: atlas-storage
description: |
  Responding to shared MongoDB storage pressure using the per-collection
  breakdown, and knowing which fixes need the platform owner.
---

# Atlas storage

Triggered by an `atlas-storage-high` alert (soft at 70%, hard at 85% of
`ATLAS_STORAGE_LIMIT_MB`, default 512 MB — the M0 free-tier quota) or an
"Atlas storage" flag in the daily report (which only appears in reports for
`PLATFORM_ADMIN_USER_IDS`). This is cluster-wide, not per-mission: it's shared
by every mission on the deployment, not scoped to any single user's own data.

## You are read-only here

You have no database tool of your own for this — everything you know comes
from the alert body or the daily report's PLATFORM section, both of which
already carry the per-database and per-collection breakdown. Your job is
telling the operator which lever to pull and with what numbers; you can't pull
any of them yourself.

## Read the breakdown before naming a cause

The breakdown lists both the app database's own collection sizes and the
total across other databases on the cluster. As of the last documented
measurement, `conversationMessages` was the overwhelming driver (over 300 MB
of roughly 315 MB in the app database) — compaction only ever marks messages
`compacted: true`, it never deletes them, so this collection only grows.
Confirm this is still the actual driver from the current breakdown rather than
assuming it — a future change could shift the picture.

## Levers, in order

1. **Drop unused databases on the shared cluster.** If the breakdown shows
   meaningful size in databases that aren't the app database, that's often
   leftover test/dev data the owner can just delete in the Atlas console —
   the cheapest fix by far, and worth checking first.
2. **A retention rule for compacted `conversationMessages`.** This does not
   exist yet — it's an open product decision (deleting compacted messages
   after N days would cap growth, but affects what the Transcripts panel and
   future audits can show). Don't propose implementing this yourself; tell
   the operator it's the real long-term fix and point at the open tracking
   issue if you have its number handy.
3. **Move up an Atlas tier.** The only lever that doesn't require a product
   decision or manual cleanup, but it's a recurring cost the operator has to
   choose to accept.

## What to say

Name the current percentage, the growth rate if the report included one
(`+X MB/24h`, `full in ~N days`), and the top 2-3 collections driving it.
Recommend the ordered levers above rather than picking one for the operator —
this is fundamentally their call on cost versus effort versus urgency, not a
judgment you have enough context to make for them.
