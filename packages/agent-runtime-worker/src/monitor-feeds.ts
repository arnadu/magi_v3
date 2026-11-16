import { entryTrigger } from "@magi/agent-config";
import type { Collection, Document, WithId } from "mongodb";

const MAX_BACKOFF_MS = 30_000;

/**
 * Follows the documents one mission inserts into `col`, calling `onInsert`
 * for each, until `onClose` fires. A change-stream error is logged and the
 * stream reopened after an exponential backoff (1 s, doubling, at most 30 s).
 * It feeds the monitor's event streams: the routes that read those streams
 * declare the operation they serve.
 */
export async function followMissionInserts<T extends Document>(opts: {
	col: Collection<T>;
	missionId: string;
	/** Names the feed in log lines, e.g. "Mailbox". */
	label: string;
	onClose: (stop: () => void) => void;
	onInsert: (doc: WithId<T>) => void;
}): Promise<void> {
	let backoffMs = 1_000;
	while (true) {
		try {
			await new Promise<void>((resolve, reject) => {
				const stream = opts.col.watch<WithId<T>>(
					[
						{
							$match: {
								operationType: "insert",
								"fullDocument.missionId": opts.missionId,
							},
						},
					],
					{ fullDocument: "updateLookup" },
				);
				stream.on(
					"change",
					entryTrigger("feed", (change) => {
						if (change.operationType !== "insert") return;
						opts.onInsert(change.fullDocument);
					}),
				);
				stream.on("error", (e) => {
					stream.close().catch(() => {});
					reject(e);
				});
				opts.onClose(() => {
					stream.close().catch(() => {});
					resolve();
				});
			});
			return;
		} catch (e) {
			console.error(
				`[monitor] ${opts.label} watch error: ${(e as Error).message}. Retrying in ${backoffMs}ms`,
			);
			await new Promise<void>((res) => setTimeout(res, backoffMs));
			backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
		}
	}
}
