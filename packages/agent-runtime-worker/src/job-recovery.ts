/**
 * Orphaned background-job recovery (F-010) — split out from daemon.ts so it is
 * unit-testable without importing the daemon's script entry point (daemon.ts
 * runs main() unconditionally at module load).
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
import type { MailboxRepository } from "./mailbox.js";

export interface JobSpec {
	/** Unique job id (UUID). */
	id: string;
	/** Agent whose linuxUser and ACL the job runs under. */
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
	 * Times this job has been swept from running/ back to pending/ by
	 * recoverOrphanedJobs (i.e. the daemon died mid-run). Absent/0 on first
	 * run. If a job's own execution is what killed the process (e.g. it OOMs
	 * the machine), blindly re-running it on every restart is an infinite
	 * crash loop — see MAX_JOB_RECOVERY_ATTEMPTS.
	 */
	recoveryAttempts?: number;
}

/**
 * Cap on how many times an orphaned job is swept back to pending/ and
 * re-executed. Beyond this, recoverOrphanedJobs treats it as poisoned (its
 * own execution likely killed the process — e.g. an OOM — so re-running it
 * unconditionally forever is an infinite crash loop, not a recovery) and
 * fails it out permanently instead of retrying.
 */
export const MAX_JOB_RECOVERY_ATTEMPTS = 2;

/**
 * F-010: On daemon startup, jobs left in jobs/running/ from a previous run have
 * no live token — their magi-tool calls will fail with 401. Move them back to
 * pending/ so they are retried with a fresh token on the next heartbeat.
 *
 * A job stuck in running/ means the daemon died mid-execution — which could be
 * an unrelated crash, OR could mean THIS job's execution is what killed the
 * process (e.g. it OOMs a 1GB machine). Blindly recovering forever turns the
 * latter into an infinite crash loop: crash → orphan → recovered → same crash.
 * Past MAX_JOB_RECOVERY_ATTEMPTS, fail the job out permanently (jobs/failed/ +
 * a status file + an operator notification) instead of retrying again.
 */
export async function recoverOrphanedJobs(
	sharedDir: string,
	missionId: string,
	mailboxRepo: MailboxRepository,
	anomalyRecorder?: AnomalyRecorder,
): Promise<void> {
	const runningDir = join(sharedDir, "jobs", "running");
	const pendingDir = join(sharedDir, "jobs", "pending");
	const failedDir = join(sharedDir, "jobs", "failed");
	const statusDir = join(sharedDir, "jobs", "status");
	let files: string[];
	try {
		files = readdirSync(runningDir).filter((f) => f.endsWith(".json"));
	} catch {
		return; // running dir does not exist yet — nothing to recover
	}
	if (files.length === 0) return;
	mkdirSync(pendingDir, { recursive: true });

	for (const file of files) {
		const src = join(runningDir, file);
		let spec: JobSpec;
		try {
			spec = JSON.parse(readFileSync(src, "utf8")) as JobSpec;
		} catch (e) {
			console.error(
				`[daemon:jobs] Failed to parse orphaned job ${file}: ${(e as Error).message} — leaving in running/ for manual inspection`,
			);
			continue;
		}
		const attempts = (spec.recoveryAttempts ?? 0) + 1;

		if (attempts > MAX_JOB_RECOVERY_ATTEMPTS) {
			console.error(
				`[daemon:jobs] Job ${spec.id} (${spec.scriptPath}) exceeded ${MAX_JOB_RECOVERY_ATTEMPTS} recovery attempts — its own execution likely crashed the process. Failing permanently, not retrying.`,
			);
			try {
				mkdirSync(failedDir, { recursive: true });
				mkdirSync(statusDir, { recursive: true });
				writeFileSync(join(failedDir, file), JSON.stringify(spec, null, 2));
				writeFileSync(
					join(statusDir, `${spec.id}.json`),
					JSON.stringify(
						{
							id: spec.id,
							scriptPath: spec.scriptPath,
							exitCode: null,
							completedAt: new Date().toISOString(),
							error: `Exceeded ${MAX_JOB_RECOVERY_ATTEMPTS} recovery attempts — likely crashes the process (e.g. OOM). Failed permanently; not retried.`,
						},
						null,
						2,
					),
				);
				unlinkSync(src);
			} catch (e) {
				console.error(
					`[daemon:jobs] Failed to fail-out ${file}: ${(e as Error).message}`,
				);
			}
			const failureMessage =
				`Job "${spec.scriptPath}" (${spec.id}) has crashed the mission process ` +
				`${attempts - 1} time(s) in a row and will NOT be retried again. ` +
				`This usually means the job itself is the cause (e.g. it exhausts machine ` +
				`memory) rather than an unrelated crash. The job spec was moved to ` +
				`jobs/failed/${file} for inspection. Manual investigation required before ` +
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

		const dst = join(pendingDir, file);
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
