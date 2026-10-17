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
/**
 * A Change Stream opened after an insert does not see it, and there is no
 * resume token across waits: mail that lands between the last unread check
 * and `watch()` is invisible until the next insert (audit MW1). The caller
 * re-checks every agent's unread mail after each wake, so a periodic wake
 * closes that gap at the cost of a few cheap queries per interval — the same
 * fallback the control plane's copilot waker has.
 */
export const MAIL_POLL_FALLBACK_MS = 15_000;

export function createMailWaiter(
	mailboxCol: Collection<Document>,
	missionId: string,
	signal: AbortSignal,
	pollFallbackMs: number = MAIL_POLL_FALLBACK_MS,
): () => Promise<void> {
	// Open a single Change Stream and resolve when a matching insert arrives.
	// Rejects on stream error so the caller can retry.
	function openChangeStream(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const pollTimer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				stream.close().catch(() => {});
				resolve();
			}, pollFallbackMs);
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
				clearTimeout(pollTimer);
				stream.close().catch(() => {});
				resolve();
			};
			signal.addEventListener("abort", onAbort, { once: true });
			stream.once("change", () => {
				clearTimeout(pollTimer);
				signal.removeEventListener("abort", onAbort);
				stream.close().catch(() => {});
				resolve();
			});
			stream.once("error", (err) => {
				clearTimeout(pollTimer);
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
