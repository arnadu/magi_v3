import type { BootContext } from "./context.js";

/**
 * Wire SIGTERM/SIGINT to abort a fresh AbortController: the first signal
 * requests graceful shutdown (ac.abort(), letting the orchestration loop
 * finish its current step and run cleanup); a second signal force-exits
 * immediately, for an operator who doesn't want to wait.
 *
 * Returns initiateShutdown alongside the BootContext fields so a test can
 * invoke it directly instead of sending real OS signals.
 */
export function wireAbortSignal(): Pick<BootContext, "ac" | "signal"> & {
	initiateShutdown: (reason: string) => void;
} {
	const ac = new AbortController();
	const { signal } = ac;
	let shutdownInitiated = false;
	function initiateShutdown(reason: string): void {
		if (shutdownInitiated) {
			// Second signal — force exit immediately.
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
	return { ac, signal, initiateShutdown };
}
