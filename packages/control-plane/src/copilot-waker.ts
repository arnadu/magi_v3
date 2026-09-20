/**
 * Starts a user's control-plane copilot daemon whenever mail addressed to it
 * arrives (ADR-0032 Decision 1).
 *
 * The daemon is otherwise only started from the operator's own /message
 * route, so anything posted to `copilot-{userId}` while no daemon is running
 * — a hard-anomaly relay from a mission, a scheduled message, the daily
 * resource report — used to sit unread until the operator next wrote to the
 * copilot. A freshly started daemon drains pre-existing unread mail on its
 * first loop iteration, so waking it is all that's needed.
 *
 * Two independent mechanisms, so a missed event never strands mail: a Change
 * Stream for prompt wake-ups, and a periodic scan (also run at startup and
 * after every stream reconnect) for anything the stream missed.
 */

import type { ChangeStream, Db } from "mongodb";

const COPILOT_MAILBOX_PREFIX = "copilot-";
const COPILOT_RECIPIENT = "copilot";
const SCAN_INTERVAL_MS = 5 * 60_000;
const REOPEN_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000];

type EnsureCopilotRunning = (userId: string) => Promise<void>;

/** `copilot-{userId}` → `userId`; null for any other mailbox id. */
export function userIdFromCopilotMissionId(missionId: unknown): string | null {
	if (typeof missionId !== "string") return null;
	if (!missionId.startsWith(COPILOT_MAILBOX_PREFIX)) return null;
	const userId = missionId.slice(COPILOT_MAILBOX_PREFIX.length);
	return userId.length > 0 ? userId : null;
}

/** Wake the copilot of every user who has unread copilot mail. Returns how many users had some. */
export async function wakeStrandedCopilots(
	db: Db,
	ensureCopilotRunning: EnsureCopilotRunning,
): Promise<number> {
	const rows = await db
		.collection("mailbox")
		.aggregate<{ _id: unknown }>([
			{
				$match: {
					missionId: { $regex: `^${COPILOT_MAILBOX_PREFIX}` },
					to: COPILOT_RECIPIENT,
					readBy: { $ne: COPILOT_RECIPIENT },
				},
			},
			{ $group: { _id: "$missionId" } },
		])
		.toArray();

	let users = 0;
	for (const row of rows) {
		const userId = userIdFromCopilotMissionId(row._id);
		if (!userId) continue;
		users++;
		await ensureCopilotRunning(userId).catch((e) =>
			console.error(
				`[copilot-waker] Failed to start copilot { userId: "${userId}", error: "${(e as Error).message}" }`,
			),
		);
	}
	return users;
}

function insertedMissionId(change: unknown): unknown {
	if (typeof change !== "object" || change === null) return undefined;
	const doc = (change as Record<string, unknown>).fullDocument;
	if (typeof doc !== "object" || doc === null) return undefined;
	return (doc as Record<string, unknown>).missionId;
}

/** Start the waker. Returns a stop function. */
export function startCopilotWaker(
	db: Db,
	ensureCopilotRunning: EnsureCopilotRunning,
	opts: { scanIntervalMs?: number } = {},
): () => void {
	let stopped = false;
	let stream: ChangeStream | null = null;
	let reopenTimer: NodeJS.Timeout | null = null;
	let consecutiveFailures = 0;

	const scan = () =>
		wakeStrandedCopilots(db, ensureCopilotRunning).catch((e) =>
			console.error(
				`[copilot-waker] Scan failed { error: "${(e as Error).message}" }`,
			),
		);

	const scheduleReopen = (reason: string) => {
		if (stopped || reopenTimer) return;
		const delay =
			REOPEN_BACKOFF_MS[
				Math.min(consecutiveFailures, REOPEN_BACKOFF_MS.length - 1)
			];
		consecutiveFailures++;
		console.error(
			`[copilot-waker] Change Stream lost { reason: "${reason}", retryInMs: ${delay} }`,
		);
		reopenTimer = setTimeout(() => {
			reopenTimer = null;
			open();
			// Anything inserted while the stream was down is picked up here.
			void scan();
		}, delay);
	};

	const open = () => {
		if (stopped) return;
		let opened: ChangeStream;
		try {
			opened = db.collection("mailbox").watch([
				{
					$match: {
						operationType: "insert",
						"fullDocument.missionId": {
							$regex: `^${COPILOT_MAILBOX_PREFIX}`,
						},
						"fullDocument.to": COPILOT_RECIPIENT,
					},
				},
			]);
		} catch (e) {
			scheduleReopen((e as Error).message);
			return;
		}
		stream = opened;
		opened.on("change", (change) => {
			consecutiveFailures = 0;
			const userId = userIdFromCopilotMissionId(insertedMissionId(change));
			if (!userId) return;
			ensureCopilotRunning(userId).catch((e) =>
				console.error(
					`[copilot-waker] Failed to start copilot { userId: "${userId}", error: "${(e as Error).message}" }`,
				),
			);
		});
		opened.on("error", (err: Error) => {
			opened.close().catch(() => {});
			if (stream === opened) stream = null;
			scheduleReopen(err.message);
		});
	};

	open();
	void scan();
	const scanTimer = setInterval(
		() => void scan(),
		opts.scanIntervalMs ?? SCAN_INTERVAL_MS,
	);
	scanTimer.unref();

	return () => {
		stopped = true;
		clearInterval(scanTimer);
		if (reopenTimer) clearTimeout(reopenTimer);
		stream?.close().catch(() => {});
	};
}
