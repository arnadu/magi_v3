import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BootContext } from "./context.js";

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
		const logStream = createWriteStream(join(workdirForLog, "daemon.log"), {
			flags: "a",
		});
		const origStdoutWrite = process.stdout.write.bind(process.stdout);
		const origStderrWrite = process.stderr.write.bind(process.stderr);
		// biome-ignore lint/suspicious/noExplicitAny: wrapping native write
		(process.stdout.write as any) = (chunk: any, ...args: any[]) => {
			logStream.write(chunk);
			return origStdoutWrite(chunk, ...args);
		};
		// biome-ignore lint/suspicious/noExplicitAny: wrapping native write
		(process.stderr.write as any) = (chunk: any, ...args: any[]) => {
			logStream.write(chunk);
			return origStderrWrite(chunk, ...args);
		};
	} catch {
		// Log setup failure is non-fatal — daemon continues without file logging.
	}
	return {};
}
