# ADR-0041: Agent OS users keep their uid for the life of the mission volume

**Status:** Accepted (2026-11-27).
**Relates to:** ADR-0011 (per-agent OS users), ADR-0033 (jobs and schedules attributed by file
owner), the threat model's TB-3, finding F-085.

## Context

On a mission machine the agent OS users live on the root disk, which is rebuilt on every boot,
while their files live on the mission volume. The daemon recreated the users at each boot with
`useradd`, which takes the next free uid, so the uid an agent got depended on the order the roster
listed it in and on how many users were created before it. Between two boots of `magi-dev-1` the
order changed and `documenter` and `qa-lead` swapped uids. Each then owned the other's files, and
each private workdir's ACL still granted the uid from the earlier boot, so either could read and
write the other's workdir. Owner-based attribution (ADR-0033) would also have assigned a job or
schedule file to the wrong agent. The documenter found itself locked out of its own clone and
report folder.

## Decision

The volume keeps a map from agent user to uid (`$AGENT_WORKDIR/.agent-uids.json`, owned by the
daemon, mode 600; `daemon-boot/uid-map.ts`). At boot:

1. Each user's uid comes from the map (seeded from the volume's files the first time, below). A user not in it gets the next uid after the highest one
   the map holds in the agent range (1001–59999) that no account holds. A user the image already
   created (`mission-copilot`) is recorded as it is.
2. The map is written, atomically, before any user is created. A uid is never given to another
   name, even after its agent leaves the roster.
3. `magi-create-user` takes the uid as a required argument and refuses one outside the range or
   held by another account, and an existing user whose uid differs.
4. A user that already exists under a uid other than its pinned one stops the boot: running it
   would give one agent another's files.
5. Provisioning removes, from the top of each private workdir, every named ACL entry other than
   the agent's and the daemon's. The daemon owns only that directory, not the agent's files below
   it, but with mode 0700 and no grant at the top nothing below can be reached.

Only uids are pinned. A per-user group's gid can still drift. That does no harm: under the
workspace's default ACLs the owning group gets nothing in a private workdir and only what
"other" gets in `shared/`.

## Alternatives

- **A uid derived from a hash of the agent id.** It needs no stored state, but a collision has to
  be resolved somehow, and any rule for that makes the result depend on the other names again.
- **Keeping `/etc/passwd` on the volume.** It would survive reboots but would mix the image's
  accounts with the mission's, so a new image could not add or change a system account.
- **Repairing ownership at boot (`chown` to the current uids).** That would mean the daemon
  holding root over agents' files, and it would treat the symptom while uids still moved.

## Consequences

- A volume with no map yet (every mission written before this version) is seeded from its
  files: each agent not created by the image gets the uid that owns most entries at the top of
  its own workdir, and a newcomer gets a uid no file is owned by. A tie, or two agents whose files
  name the same uid, stops the boot with a message to write the map by hand: a guess would hand
  one agent another's files. On `magi-dev-1` this restores the uids from before the swap; the few
  files written since the swap stay owned by the other uid but remain writable through `shared/`'s
  inherited ACL, and are handed back by hand.
- Local dev is unchanged: the pool users are fixed and the map is not used.
