import type { BootContext } from "./context.js";

/**
 * Wire SIGTERM/SIGINT, and — issue #46 — uncaughtException/unhandledRejection,
 * to abort a fresh AbortController: the first trigger requests graceful
 * shutdown (ac.abort(), letting the orchestration loop finish its current
 * step and run cleanup); a second trigger force-exits immediately, for an
 * operator who doesn't want to wait (or a shutdown itself that's hung).
 *
 * Before #46, an uncaught exception or unhandled rejection from any
 * sub-component (observed live via a Stagehand/BrowseWeb internal throw) hard-
 * crashed the process with no handler at all — no graceful shutdown, no PID
 * file cleanup, no AbortController firing to cancel in-flight agent turns.
 * Routing these through the same initiateShutdown() as SIGTERM/SIGINT means
 * a crash at least attempts the same cleanup a clean shutdown would, rather
 * than skipping it entirely.
 *
 * Returns initiateShutdown alongside the BootContext fields so a test can
 * invoke it directly instead of sending real OS signals or throwing for real.
 */
export function wireAbortSignal(): Pick<BootContext, "ac" | "signal"> & {
	initiateShutdown: (reason: string) => void;
} {
	const ac = new AbortController();
	const { signal } = ac;
	let shutdownInitiated = false;
	function initiateShutdown(reason: string): void {
		if (shutdownInitiated) {
			// Second trigger — force exit immediately.
			console.log("\n[daemon] Force exit");
			process.exit(1);
		}
		shutdownInitiated = true;
		console.log(
			`\n[daemon] ${reason} — shutting down… (Ctrl-C again to force)`,
		);
		ac.abort();
	}
	process.on("SIGTERM", () => initiateShutdown("SIGTERM"));
	process.on("SIGINT", () => initiateShutdown("Interrupted"));
	process.on("uncaughtException", (err) => {
		console.error(
			`[daemon] Uncaught exception: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
		);
		initiateShutdown("Uncaught exception");
	});
	process.on("unhandledRejection", (reason) => {
		console.error(
			`[daemon] Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
		);
		initiateShutdown("Unhandled rejection");
	});
	return { ac, signal, initiateShutdown };
}
