/**
 * Control-plane scheduled tasks.
 *
 * 1. Scheduled message delivery — every minute:
 *      Find scheduled_messages where deliverAt <= now && status == "pending".
 *      For each: look up the mission's machineId, resume the machine if stopped,
 *      insert the message into mailbox, mark delivered, re-arm cron entries.
 *
 * 2. Log retention pruning — daily at 02:00 UTC:
 *      Strip `input` and `output` from llmCallLog entries older than 7 days.
 *      Usage/cost metadata is preserved indefinitely for billing reconciliation.
 *      This keeps storage manageable on the M0/M2 Atlas tier while retaining
 *      full context for active debugging windows.
 */

import cronParser from "cron-parser";
import type { Db } from "mongodb";
import { schedule } from "node-cron";
import { getMachineState, resumeMission } from "./fly-machines.js";

const { parseExpression } = cronParser;

interface ScheduledMessageDoc {
	_id: unknown;
	missionId: string;
	to: string[];
	subject: string;
	body: string;
	deliverAt: Date;
	cron?: string;
	label?: string;
	status: "pending" | "delivered" | "cancelled";
}

interface MissionDoc {
	_id: unknown;
	missionId: string;
	machineId?: string;
	status: string;
}

async function deliver(db: Db): Promise<void> {
	const scheduledCol = db.collection<ScheduledMessageDoc>("scheduled_messages");
	const mailboxCol = db.collection("mailbox");
	const missionsCol = db.collection<MissionDoc>("missions");

	const now = new Date();

	while (true) {
		// Atomically claim one pending message.
		const doc = await scheduledCol.findOneAndUpdate(
			{ status: "pending", deliverAt: { $lte: now } },
			{ $set: { status: "delivered" } },
		);
		if (!doc) break;

		try {
			// Wake the execution plane machine if it is stopped.
			const mission = await missionsCol.findOne({ missionId: doc.missionId });
			if (mission?.machineId) {
				const state = await getMachineState(mission.machineId).catch(
					() => "unknown",
				);
				if (state !== "started" && state !== "starting") {
					console.log(
						`[scheduler] Resuming machine ${mission.machineId} for mission ${doc.missionId}`,
					);
					await resumeMission(mission.machineId);
				}
			}

			// Deliver to mailbox.
			await mailboxCol.insertOne({
				missionId: doc.missionId,
				from: "scheduler",
				to: doc.to,
				subject: doc.subject,
				body: doc.body,
				read: false,
				createdAt: new Date(),
			});
			console.log(
				`[scheduler] Delivered "${doc.subject}" to ${doc.to.join(", ")} (mission ${doc.missionId})`,
			);
		} catch (e) {
			// Re-open the message so it is retried on the next tick.
			await scheduledCol.updateOne(
				{ _id: doc._id },
				{ $set: { status: "pending" } },
			);
			console.error(
				`[scheduler] Failed to deliver message: ${(e as Error).message}`,
			);
			continue;
		}

		// Re-arm cron-based entries.
		if (doc.cron) {
			try {
				const next = parseExpression(doc.cron).next().toDate();
				await scheduledCol.updateOne(
					{ _id: doc._id },
					{ $set: { status: "pending", deliverAt: next } },
				);
				console.log(
					`[scheduler] Re-armed "${doc.label ?? doc.subject}" → next at ${next.toISOString()}`,
				);
			} catch (e) {
				console.error(
					`[scheduler] Failed to re-arm cron: ${(e as Error).message}`,
				);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Log retention pruning
// ---------------------------------------------------------------------------

const LOG_RETENTION_DAYS = 7;

/**
 * Strip `input` and `output` from llmCallLog entries older than LOG_RETENTION_DAYS.
 * Runs on startup (to catch anything missed while the control plane was down) and
 * then daily at 02:00 UTC.
 */
async function pruneOldLogEntries(db: Db): Promise<void> {
	const cutoff = new Date(
		Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
	);
	const result = await db.collection("llmCallLog").updateMany(
		{
			savedAt: { $lt: cutoff },
			$or: [{ input: { $exists: true } }, { output: { $exists: true } }],
		},
		{ $unset: { input: "", output: "" } },
	);
	if (result.modifiedCount > 0) {
		console.log(
			`[scheduler] Log pruning: stripped input/output from ${result.modifiedCount} entries older than ${LOG_RETENTION_DAYS} days`,
		);
	}
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/** Start the scheduled delivery heartbeat and log pruner. Returns a stop function. */
export function startScheduler(db: Db): () => void {
	const tick = () =>
		deliver(db).catch((e) => console.error("[scheduler] Delivery error:", e));

	const prune = () =>
		pruneOldLogEntries(db).catch((e) =>
			console.error("[scheduler] Pruning error:", e),
		);

	// Deliver any overdue messages immediately on startup.
	tick();
	// Prune any stale log entries immediately on startup (catches missed days).
	prune();

	const deliveryTask = schedule("* * * * *", tick);
	// Daily at 02:00 UTC.
	const pruneTask = schedule("0 2 * * *", prune);

	return () => {
		deliveryTask.stop();
		pruneTask.stop();
	};
}
