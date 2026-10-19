/**
 * Orphaned background-job recovery (F-010) and the job-spec types shared with
 * job-runner.ts. Split out of daemon.ts so it is unit-testable without
 * importing the daemon's script entry point.
 *
 * Operates on the daemon-private job directories (`JobDirs`, see
 * job-runner.ts): the running set and the authoritative status live where
 * agents cannot write, so what recovery re-queues is what the daemon itself
 * put there.
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AnomalyRecorder } from "./anomaly.js";
import type { JobDirs } from "./job-runner.js";
import type { MailboxRepository } from "./mailbox.js";
import { readInside, writeFileInside } from "./safe-path.js";

export interface JobSpec {
	/** Unique job id (UUID or slug — see JOB_ID_RE). */
	id: string;
	/** Agent whose linuxUser and ACL the job runs under. For agent-submitted specs this must equal the file owner's agent. */
	agentId: string;
	/** Absolute path to the script (shebang selects interpreter). */
	scriptPath: string;
	/** Positional arguments passed after scriptPath. */
	args: string[];
	/** If set, post a mailbox message to this agent on completion. */
	notifyAgentId?: string;
	/** Subject for the completion notification. */
	notifySubject?: string;
	/**
	 * Wall-clock timeout in milliseconds (F-006).
	 * The job process (and its entire process group) is killed after this delay.
	 * Default: 30 minutes.
	 */
	timeoutMs?: number;
	/**
	 * Times this job has been swept from running/ back to the queue by
	 * recoverOrphanedJobs (i.e. the daemon died mid-run). Absent/0 on first
	 * run. If a job's own execution is what killed the process (e.g. it OOMs
	 * the machine), blindly re-running it on every restart is an infinite
	 * crash loop — see MAX_JOB_RECOVERY_ATTEMPTS.
	 */
	recoveryAttempts?: number;
}

/** Job ids are UUIDs or slugs; anything else cannot name a file (and `../` must never reach a path). */
export const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;

/**
 * The status record of a finished job, read from the daemon-private status
 * directory (the agent-readable mirror under `shared/` is never trusted for
 * this — an agent could forge one and have the copilot resubmit an arbitrary
 * spec). The id is validated as a slug, and a job that exited 0 is refused:
 * it is neither failed nor cancelled, and resubmitting it would be a silent
 * duplicate run.
 */
export function readFailedJobStatus(
	dirs: JobDirs,
	jobId: string,
): { spec: JobSpec & { exitCode?: number } } | { error: string } {
	if (!JOB_ID_RE.test(jobId)) {
		return {
			error: `Invalid job id "${jobId}" — ids are the slugs ListBackgroundJobs shows.`,
		};
	}
	let spec: JobSpec & { exitCode?: number };
	try {
		spec = JSON.parse(
			readInside(dirs.privateRoot, `status/${jobId}.json`, {
				maxBytes: 1_000_000,
			}).bytes.toString("utf8"),
		);
	} catch {
		return {
			error: `No completed job "${jobId}" found — only a job that finished under this daemon can be resubmitted (check ListBackgroundJobs).`,
		};
	}
	if (spec.exitCode === 0) {
		return {
			error: `Job "${jobId}" completed successfully (exit 0) — RestartBackgroundJob is for failed or cancelled jobs. To run it again, submit it as a new job.`,
		};
	}
	return { spec };
}

/**
 * Cap on how many times an orphaned job is swept back to the queue and
 * re-executed. Beyond this, recoverOrphanedJobs treats it as poisoned (its
 * own execution likely killed the process — e.g. an OOM — so re-running it
 * unconditionally forever is an infinite crash loop, not a recovery) and
 * fails it out permanently instead of retrying.
 */
export const MAX_JOB_RECOVERY_ATTEMPTS = 2;

/**
 * F-010: On daemon startup, jobs left in the private running/ set by a
 * previous run have no live token — their magi-tool calls would fail with
 * 401. Move them to the private queue so they are retried with a fresh token
 * on the next heartbeat.
 *
 * A job stuck in running/ means the daemon died mid-execution — which could
 * be an unrelated crash, OR could mean THIS job's execution is what killed
 * the process (e.g. it OOMs a 1GB machine). Blindly recovering forever turns
 * the latter into an infinite crash loop: crash → orphan → recovered → same
 * crash. Past MAX_JOB_RECOVERY_ATTEMPTS, fail the job out permanently
 * (failed/ + a status file + an operator notification) instead of retrying.
 */
export async function recoverOrphanedJobs(
	dirs: JobDirs,
	missionId: string,
	mailboxRepo: MailboxRepository,
	anomalyRecorder?: AnomalyRecorder,
): Promise<void> {
	let files: string[];
	try {
		files = readdirSync(dirs.running).filter((f) => f.endsWith(".json"));
	} catch {
		return; // running dir does not exist yet — nothing to recover
	}
	if (files.length === 0) return;
	mkdirSync(dirs.queue, { recursive: true, mode: 0o700 });

	for (const file of files) {
		const src = join(dirs.running, file);
		let spec: JobSpec;
		try {
			spec = JSON.parse(readFileSync(src, "utf8")) as JobSpec;
		} catch (e) {
			console.error(
				`[daemon:jobs] Failed to parse orphaned job ${file}: ${(e as Error).message} — leaving in running/ for manual inspection`,
			);
			continue;
		}
		if (!JOB_ID_RE.test(spec.id) || `${spec.id}.json` !== file) {
			console.error(
				`[daemon:jobs] Orphaned job ${file} has an id that does not match its file name — leaving in running/ for manual inspection`,
			);
			continue;
		}
		const attempts = (spec.recoveryAttempts ?? 0) + 1;

		if (attempts > MAX_JOB_RECOVERY_ATTEMPTS) {
			console.error(
				`[daemon:jobs] Job ${spec.id} (${spec.scriptPath}) exceeded ${MAX_JOB_RECOVERY_ATTEMPTS} recovery attempts — its own execution likely crashed the process. Failing permanently, not retrying.`,
			);
			const status = JSON.stringify(
				{
					id: spec.id,
					scriptPath: spec.scriptPath,
					exitCode: null,
					completedAt: new Date().toISOString(),
					error: `Exceeded ${MAX_JOB_RECOVERY_ATTEMPTS} recovery attempts — likely crashes the process (e.g. OOM). Failed permanently; not retried.`,
				},
				null,
				2,
			);
			try {
				mkdirSync(dirs.failed, { recursive: true, mode: 0o700 });
				mkdirSync(dirs.status, { recursive: true, mode: 0o700 });
				writeFileSync(join(dirs.failed, file), JSON.stringify(spec, null, 2));
				writeFileSync(join(dirs.status, `${spec.id}.json`), status);
				unlinkSync(src);
			} catch (e) {
				console.error(
					`[daemon:jobs] Failed to fail-out ${file}: ${(e as Error).message}`,
				);
			}
			mirrorStatus(dirs.statusMirror, spec.id, status);
			const failureMessage =
				`Job "${spec.scriptPath}" (${spec.id}) has crashed the mission process ` +
				`${attempts - 1} time(s) in a row and will NOT be retried again. ` +
				`This usually means the job itself is the cause (e.g. it exhausts machine ` +
				`memory) rather than an unrelated crash. The job spec was kept in the ` +
				`daemon's failed set for inspection. Manual investigation required before ` +
				`resubmitting it.`;
			await mailboxRepo
				.post({
					missionId,
					from: "scheduler",
					to: [spec.notifyAgentId ?? "user"],
					subject: `Background job permanently failed: ${spec.id}`,
					body: failureMessage,
				})
				.catch((e: Error) =>
					console.error(
						`[daemon:jobs] Failed to notify about permanently-failed job ${spec.id}: ${e.message}`,
					),
				);
			// Also record it as a mission-wide anomaly — the notification above
			// only reaches spec.notifyAgentId (or "user"), which may not be the
			// mission copilot; the anomaly log makes it visible mission-wide.
			await anomalyRecorder
				?.record({
					missionId,
					category: "job-failure",
					severity: "hard",
					message: failureMessage,
				})
				.catch((e: Error) =>
					console.error(
						`[daemon:jobs] Failed to record job-failure anomaly for ${spec.id}: ${e.message}`,
					),
				);
			continue;
		}

		const dst = join(dirs.queue, file);
		try {
			writeFileSync(
				dst,
				JSON.stringify({ ...spec, recoveryAttempts: attempts }, null, 2),
			);
			unlinkSync(src);
			console.log(
				`[daemon:jobs] Recovered orphaned job: ${file} (attempt ${attempts}/${MAX_JOB_RECOVERY_ATTEMPTS})`,
			);
		} catch (e) {
			console.error(
				`[daemon:jobs] Failed to recover ${file}: ${(e as Error).message}`,
			);
		}
	}
}

/** The agent-readable copy of a job's status in shared/jobs/status; a failure only costs agents that view. */
function mirrorStatus(dir: string, jobId: string, status: string): void {
	try {
		writeFileInside(dir, `${jobId}.json`, status);
	} catch (e) {
		console.warn(
			`[daemon:jobs] Status mirror write failed for ${jobId}: ${(e as Error).message} — agents will not see its final status in shared/jobs/status`,
		);
	}
}
