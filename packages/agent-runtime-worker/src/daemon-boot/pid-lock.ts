import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BootContext } from "./context.js";

/**
 * PID file — enables cli:stop and guards against duplicate daemons for the
 * same mission. A live PID belonging to another process refuses to start
 * (bare process.exit(1) — this never needs to unwind through main()'s own
 * scope). A stale PID (file present but no matching live process) means the
 * prior run didn't reach graceful shutdown; that's recorded as a soft
 * anomaly, not just a console.warn, since it's a real signal worth keeping.
 */
export function lockPidFile(
	ctx: Pick<BootContext, "workdir" | "missionId" | "anomalyRecorder">,
): Pick<BootContext, "pidFile"> {
	const missionDir = join(ctx.workdir, "missions", ctx.missionId);
	mkdirSync(missionDir, { recursive: true });
	const pidFile = join(missionDir, "daemon.pid");

	// Check for a running instance before writing our own PID.
	try {
		const existingPid = Number.parseInt(
			readFileSync(pidFile, "utf8").trim(),
			10,
		);
		if (!Number.isNaN(existingPid) && existingPid !== process.pid) {
			try {
				// Signal 0 tests liveness without sending a real signal.
				process.kill(existingPid, 0);
				// If we reach here the process is alive — refuse to start.
				console.error(
					`[daemon] Already running as PID ${existingPid} (mission: ${ctx.missionId}).`,
				);
				console.error(
					`[daemon] Run: MISSION_ID=${ctx.missionId} npm run cli:stop`,
				);
				process.exit(1);
			} catch {
				// ESRCH — process is gone; stale PID file, safe to continue.
				console.warn(
					`[daemon] Stale PID file (PID ${existingPid} not found) — starting fresh.`,
				);
				// A live PID with no matching process means the prior run never
				// reached graceful shutdown (SIGKILL, OOM kill, machine crash).
				// This can't identify the cause (that would need polling the Fly
				// Machines API — deliberately out of scope here), but "the process
				// died abnormally" is a real, cheap signal worth recording rather
				// than silently swallowing into a console.warn no one reads.
				ctx.anomalyRecorder
					.record({
						missionId: ctx.missionId,
						category: "unclean-restart",
						severity: "soft",
						message: `Daemon restarted after an unclean shutdown (stale PID ${existingPid} with no matching live process) — the prior run did not exit gracefully.`,
					})
					.catch((e: Error) =>
						console.error(
							`[daemon] Failed to record unclean-restart anomaly: ${e.message}`,
						),
					);
			}
		}
	} catch {
		// PID file missing or unreadable — first start, proceed normally.
	}

	writeFileSync(pidFile, String(process.pid));
	return { pidFile };
}
