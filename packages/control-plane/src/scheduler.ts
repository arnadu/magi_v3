/**
 * Scheduled message delivery heartbeat (Sprint 14).
 *
 * Replaces daemon.ts's node-cron scheduler. Runs in the always-on control
 * plane so execution plane machines can be fully suspended between sessions.
 *
 * Every minute:
 *   1. Find scheduled_messages where deliverAt <= now && status == "pending".
 *   2. For each: look up the mission's machineId in the missions collection.
 *   3. If the machine is stopped: resume it, wait for started.
 *   4. Insert the message into the mailbox collection.
 *   5. Set status = "delivered" and re-arm for the next cron occurrence.
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

/** Start the scheduled delivery heartbeat. Returns a stop function. */
export function startScheduler(db: Db): () => void {
	const tick = () =>
		deliver(db).catch((e) => console.error("[scheduler] Error:", e));

	// Deliver any overdue messages immediately on startup.
	tick();

	const task = schedule("* * * * *", tick);
	return () => task.stop();
}
