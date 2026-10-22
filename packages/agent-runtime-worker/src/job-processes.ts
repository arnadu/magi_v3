/**
 * The registry of running background jobs, and how one is killed. Kept apart
 * from job-runner.ts so the kill path — which crosses the sudo boundary —
 * can be read on its own.
 */

import { execFileSync } from "node:child_process";

/** jobId → how to kill it, so CancelBackgroundJob can reach a running job's process group. */
const runningJobProcesses = new Map<string, { kill: () => boolean }>();

/** Jobs killed by CancelBackgroundJob, so their exit is recorded as cancelled, not failed (MC9). */
const cancelledJobs = new Set<string>();

export function registerRunningJob(jobId: string, kill: () => boolean): void {
	runningJobProcesses.set(jobId, { kill });
}

/** Forget a finished job; true when CancelBackgroundJob had killed it. */
export function unregisterRunningJob(jobId: string): boolean {
	runningJobProcesses.delete(jobId);
	return cancelledJobs.delete(jobId);
}

/**
 * Kill a running background job's entire process group (the same
 * SIGKILL-the-group the wall-clock timeout uses). False when the job isn't
 * running — already exited, or unknown id — or the kill failed.
 */
export function cancelBackgroundJob(jobId: string): boolean {
	const job = runningJobProcesses.get(jobId);
	if (!job || !job.kill()) return false;
	cancelledJobs.add(jobId);
	return true;
}

/**
 * SIGKILL a job's whole process group (its pgid is the sudo process's pid —
 * the job is spawned detached). The job's processes belong to the agent's OS
 * user, which the daemon may not signal: a group kill sent by the daemon
 * reaches only sudo, which cannot relay SIGKILL, and the job runs on. So the
 * kill runs as the agent, through the same magi-job sudo rule that started
 * it. The pgid is the daemon's own number, never agent input. True when the
 * signal was delivered.
 */
export function killJobGroup(pgid: number, linuxUser: string): boolean {
	try {
		execFileSync(
			"sudo",
			[
				"-n",
				"-u",
				linuxUser,
				"/usr/local/bin/magi-job",
				"/bin/sh",
				"-c",
				'kill -s KILL -- "-$1"',
				"magi-kill",
				String(pgid),
			],
			{ stdio: "ignore", timeout: 10_000 },
		);
		return true;
	} catch (e) {
		console.error(
			`[daemon:jobs] Could not kill job process group ${pgid} as ${linuxUser}: ${(e as Error).message} — it may keep running`,
		);
		return false;
	}
}
