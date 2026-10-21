import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
/**
 * True when `pid` is a live daemon process. On Linux the command line must
 * name the daemon: after a container restart PIDs start over, and the old
 * daemon's PID may now belong to sudo, a tool executor or Chromium — which
 * used to read as "already running" and crash-loop the restart (PID1).
 * Without /proc (macOS dev) liveness is all there is to go on.
 */
export function pidHoldsDaemon(
	pid: number,
	readCmdline = (p: number) => readFileSync(`/proc/${p}/cmdline`, "utf8"),
): boolean {
	try {
		// Signal 0 tests liveness without sending a real signal.
		process.kill(pid, 0);
	} catch {
		return false;
	}
	if (!existsSync("/proc/self/cmdline")) return true;
	try {
		return readCmdline(pid).includes("daemon.js");
	} catch {
		return false;
	}
}

export function lockPidFile(
	ctx: Pick<BootContext, "workdir" | "missionId" | "anomalyRecorder">,
	holdsDaemon: (pid: number) => boolean = pidHoldsDaemon,
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
		// Our own PID in the file means the previous daemon died and this one
		// was given the same number — still an unclean restart (PID1).
		if (
			!Number.isNaN(existingPid) &&
			existingPid !== process.pid &&
			holdsDaemon(existingPid)
		) {
			console.error(
				`[daemon] Already running as PID ${existingPid} (mission: ${ctx.missionId}).`,
			);
			console.error(
				`[daemon] Run: MISSION_ID=${ctx.missionId} npm run cli:stop`,
			);
			process.exit(1);
		} else if (!Number.isNaN(existingPid)) {
			console.warn(
				`[daemon] Stale PID file (PID ${existingPid} is not a running daemon) — starting fresh.`,
			);
			// The prior run never reached graceful shutdown (SIGKILL, OOM kill,
			// machine crash). This can't identify the cause (that would need
			// the Fly Machines API — deliberately out of scope here), but "the
			// process died abnormally" is a real, cheap signal worth recording.
			ctx.anomalyRecorder
				.record({
					missionId: ctx.missionId,
					category: "unclean-restart",
					severity: "soft",
					message: `Daemon restarted after an unclean shutdown (stale PID ${existingPid}, not a running daemon) — the prior run did not exit gracefully.`,
				})
				.catch((e: Error) =>
					console.error(
						`[daemon] Failed to record unclean-restart anomaly: ${e.message}`,
					),
				);
		}
	} catch {
		// PID file missing or unreadable — first start, proceed normally.
	}

	writeFileSync(pidFile, String(process.pid));
	return { pidFile };
}
