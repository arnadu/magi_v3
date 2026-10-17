import { createWriteStream, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BootContext } from "./context.js";

/** Above this the previous log is kept once as `daemon.log.1` and a fresh file starts (LG1). */
export const LOG_ROTATE_BYTES = 50 * 1024 * 1024;

export function rotateIfLarge(
	logPath: string,
	limit: number = LOG_ROTATE_BYTES,
): boolean {
	try {
		if (statSync(logPath).size < limit) return false;
		renameSync(logPath, `${logPath}.1`);
		return true;
	} catch {
		return false; // no file yet, or not renameable — append as before
	}
}

/**
 * Tee all stdout/stderr to $AGENT_WORKDIR/daemon.log (append mode, survives
 * restarts). The operator can read this file via GET /log on the monitor
 * server. Log setup failure is non-fatal — the daemon continues without file
 * logging.
 *
 * No BootContext fields in or out: this monkey-patches the global
 * process.stdout/stderr directly, which persist independently of ctx for the
 * rest of the process's lifetime. Extracted first specifically because it's
 * the smallest possible case for proving the Pick<BootContext,...>/
 * Object.assign extraction pattern before applying it to phases with real
 * inputs and outputs.
 */
export function setupLogTee(): Pick<BootContext, never> {
	// Synchronous write so the line is never lost if the process exits immediately.
	process.stdout.write("[daemon] Starting up…\n");

	const workdirForLog = process.env.AGENT_WORKDIR ?? process.cwd();
	try {
		mkdirSync(workdirForLog, { recursive: true });
		const logPath = join(workdirForLog, "daemon.log");
		const rotated = rotateIfLarge(logPath);
		const logStream = createWriteStream(logPath, { flags: "a" });
		const origStdoutWrite = process.stdout.write.bind(process.stdout);
		const origStderrWrite = process.stderr.write.bind(process.stderr);
		// A write error on the log file (ENOSPC is the documented one) used to be
		// an unhandled stream error — a crash of the whole daemon because its
		// log disk was full. Stop teeing, keep running.
		let teeing = true;
		logStream.on("error", (e) => {
			teeing = false;
			origStderrWrite(
				`[daemon] daemon.log write failed: ${e.message} — file logging disabled for this process; stdout/stderr continue\n`,
			);
		});
		// biome-ignore lint/suspicious/noExplicitAny: wrapping native write
		(process.stdout.write as any) = (chunk: any, ...args: any[]) => {
			if (teeing) logStream.write(chunk);
			return origStdoutWrite(chunk, ...args);
		};
		// biome-ignore lint/suspicious/noExplicitAny: wrapping native write
		(process.stderr.write as any) = (chunk: any, ...args: any[]) => {
			if (teeing) logStream.write(chunk);
			return origStderrWrite(chunk, ...args);
		};
		if (rotated) {
			console.log(
				`[daemon] daemon.log exceeded ${LOG_ROTATE_BYTES} bytes — previous log kept as daemon.log.1`,
			);
		}
	} catch {
		// Log setup failure is non-fatal — daemon continues without file logging.
	}
	return {};
}
