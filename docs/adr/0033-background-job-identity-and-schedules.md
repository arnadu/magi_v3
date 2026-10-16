# ADR-0033 — Background-job identity by file owner, a daemon-private job queue, and `shared/schedules` ingestion

**Status:** Accepted (identity + private queue implemented 2026-10-17, Sprint 28f M1 B4; schedule ingestion planned for M4)  
**Supersedes in part:** ADR-0011 (the `shared/jobs/{running,status}` layout)

## Context

Two mechanisms let agents run work outside their own turn:

- **Background jobs.** `run-background/scripts/submit-job.sh` writes a spec into
  `shared/jobs/pending/<id>.json`; the daemon's 60 s tick runs it as `sudo -u <linuxUser>` and
  issues a Tool API token for that identity. The daemon derived `linuxUser` from the spec's
  `agentId` via the roster and explicitly refused a `linuxUser` field — but it trusted `agentId`
  itself. Any agent could write a spec naming another agent (or the mission copilot) and have
  its code run as that user with that user's token (audit 2026-10, **JOB1**). The spec's `id`
  also went unvalidated into paths (**JOB2**), and everything the daemon wrote about a job
  (`running/`, `status/`) sat in `shared/`, where `applySharedAcl`'s default ACL makes every
  file writable and renamable by every agent — so a daemon-written status could be forged to
  make the copilot's `RestartBackgroundJob` resubmit an arbitrary spec.
- **Schedules.** `schedule-task/scripts/schedule.sh` and `run-background/scripts/schedule-job.sh`
  write `shared/schedules/<label>.json` and promise that "the daemon upserts into
  `scheduled_messages`" / "fires on the cron and re-arms". Nothing reads `shared/schedules`
  (**SCHED1/SCHED2**); the only working scheduler is the control plane's `scheduled_messages`
  delivery, which agents reach through the mission copilot's `CreateScheduledMessage`.

Two facts shape the design. (1) A suspended mission has no daemon tick, so only the control
plane's clock can fire anything on time. (2) The daemon is the only process that can `sudo`, so
the **owner uid of a file an agent wrote is the one identity claim an agent cannot forge**.

## Decision

### 1. A job runs as the owner of its spec file

`job-runner.ts` attributes every spec in `shared/jobs/pending/` to the uid that owns the file,
mapped to an agent through the roster's OS users (`buildUidToAgentId`, built once at boot). The
spec's `agentId` must agree with that owner or the spec is refused; `linuxUser` is never read.
Also refused: symlinks, files with more than one hard link, files owned by the daemon's own uid
(a daemon-owned file in `pending/` can only be a rename or a plant), unknown owners, files
larger than 64 KB, and a file name that is not a slug equal to `spec.id`. A refused file is
removed and logged so it cannot be retried forever. `submit-job.sh`'s `--agent` now defaults to
`$AGENT_ID` and the skill says plainly that it must be the submitter.

### 2. Daemon-authored job state lives beside `shared/`, not in it

`<AGENT_WORKDIR>/missions/<id>/jobs-private/{queue,running,failed,status}` — same placement
and ownership as `shared.git` (the mission directory carries no agent ACL), mode 0700. Specs the
daemon writes itself go to `queue/` (the copilot's `RestartBackgroundJob`, orphan recovery, and
in M4 the scheduled job fires); `running/` is the claim set; `status/` is authoritative and is
what `readFailedJobStatus` reads. `shared/jobs/status/` is kept as an **agent-readable mirror**
so `ls` and `ListBackgroundJobs` keep showing finished jobs. `recoverOrphanedJobs` operates on
the private directories only.

### 3. One `scheduled_messages` collection; the control plane keeps time, the daemon keeps execution *(planned, M4)*

`ScheduledMessageDoc` gains optional `kind: "message" | "job"` (absent = message, so existing
writers are untouched), `origin: "shared-schedules"`, `specHash`, `createdBy` (the agent derived
from the schedule file's owner uid — the same attribution as §1), `jobSpec`, and
`pendingFire?: {dueAt, requestedAt}`.

- *Ingestion* (daemon, `schedule-ingest.ts`, in the 60 s tick before `runPendingJobs`): `lstat`
  each `shared/schedules/*.json` (same refusals as §1), label = file stem, idempotency key
  `{missionId, origin, label}` (partial unique index), `$setOnInsert` on first sight, re-arm
  (`deliverAt = next(cron)`, `status: pending`) only when `specHash` changed or the doc was
  cancelled, labels with no file → `cancelled`. `CancelScheduledMessage` on an `origin` doc
  also unlinks the file.
- *Firing jobs* (control plane `scheduler.ts deliver()`): for `kind: "job"` no mailbox insert —
  `$set pendingFire` (overwrite = coalesce missed occurrences), then the existing re-arm and
  machine wake. The daemon's tick `claimJobFires()` writes `jobs-private/queue/<label>-<dueAtEpoch>.json`
  (deterministic → idempotent across a crash) then clears `pendingFire` with a CAS on `dueAt`.
  Catch-up after a suspend fires once; if `now - dueAt > 6 h` it skips and records a
  `scheduling-failure` anomaly.

## Consequences

- JOB1/JOB2 close structurally: no field in a spec can change who a job runs as or which file
  the daemon touches. The copilot can still restart jobs — for the identity the job already had.
- Agents lose `ls shared/jobs/running` (the running set is private); the status mirror and
  `ListBackgroundJobs` compensate.
- The uid mapping assumes real OS users per agent. In local dev the pool mapping already fails
  loudly when oversubscribed; `buildUidToAgentId` additionally refuses two agents on one uid.
- The control plane learns about `jobSpec` (M4): it gains wake-up and one catch-up policy; a
  daemon-only schedule store could never fire on a suspended machine.
- Fire-once-with-6 h-cap can skip a legitimately late run; the anomaly makes it visible.

## Alternatives considered

- *Submit jobs through the authenticated Tool API* (token carries the submitter). Rejected:
  `submit-job.sh` runs inside the agent's Bash turn, which has no token; uid attribution gives
  the same guarantee with no new credential.
- *Keep `shared/jobs/{running,status}` and sign the records.* Rejected: a signature only proves
  authorship, not that the file is the one the daemon meant; moving the state out of the
  agent-writable tree is simpler and also fixes the rename problem.
- *A daemon-only `scheduledJobs` collection.* Rejected (see fact 1): it cannot fire while the
  machine is stopped.
