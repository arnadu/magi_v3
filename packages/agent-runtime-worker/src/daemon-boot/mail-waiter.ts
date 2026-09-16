import type { Collection, Document } from "mongodb";

/**
 * Build the daemon's sleep-until-mail hook: a single-shot Change Stream
 * watch, wrapped with exponential backoff so a transient MongoDB network
 * error doesn't crash the daemon.
 *
 * A factory rather than a Pick<BootContext,...>-typed phase function: unlike
 * the other boot phases, its output isn't a value to merge into ctx but a
 * closure the orchestration loop calls repeatedly for the rest of the
 * mission's life, so it takes its three captured values (mailboxCol,
 * missionId, signal) directly.
 */
export function createMailWaiter(
	mailboxCol: Collection<Document>,
	missionId: string,
	signal: AbortSignal,
): () => Promise<void> {
	// Open a single Change Stream and resolve when a matching insert arrives.
	// Rejects on stream error so the caller can retry.
	function openChangeStream(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const stream = mailboxCol.watch(
				[
					{
						$match: {
							operationType: "insert",
							"fullDocument.missionId": missionId,
						},
					},
				],
				{ fullDocument: "updateLookup" },
			);
			const onAbort = () => {
				stream.close().catch(() => {});
				resolve();
			};
			signal.addEventListener("abort", onAbort, { once: true });
			stream.once("change", () => {
				signal.removeEventListener("abort", onAbort);
				stream.close().catch(() => {});
				resolve();
			});
			stream.once("error", (err) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			});
		});
	}

	return async function waitForMail(): Promise<void> {
		if (signal.aborted) return;
		let backoffMs = 1_000;
		while (!signal.aborted) {
			try {
				await openChangeStream();
				return;
			} catch (e) {
				if (signal.aborted) return;
				console.error(
					`[daemon] Change Stream error: ${(e as Error).message}. Retrying in ${backoffMs}ms`,
				);
				await new Promise<void>((res) => {
					const timer = setTimeout(res, backoffMs);
					signal.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							res();
						},
						{ once: true },
					);
				});
				backoffMs = Math.min(backoffMs * 2, 30_000);
			}
		}
	};
}
