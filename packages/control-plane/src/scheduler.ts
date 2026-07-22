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

import { randomUUID } from "node:crypto";
import { parseTeamConfig } from "@magi/agent-config";
import {
	createMongoAnomalyRecorder,
	createMongoMailboxRepository,
	MISSION_COPILOT_AGENT_ID,
} from "@magi/agent-runtime-worker";
import cronParser from "cron-parser";
import type { Collection, Db } from "mongodb";
import { schedule } from "node-cron";
import { getMachineState, resumeMission } from "./fly-machines.js";

const { parseExpression } = cronParser;

/**
 * Cap on how many consecutive delivery failures a scheduled message tolerates
 * before it's given up on, mirroring MAX_JOB_RECOVERY_ATTEMPTS's reasoning in
 * agent-runtime-worker/job-recovery.ts: a transient failure (Mongo hiccup, a
 * momentary machine-resume error) should retry, but reopening the same
 * message to "pending" forever when the underlying cause is permanent (e.g.
 * the mission's machineId is gone) is a silent, invisible failure loop, not a
 * recovery. Past this cap, mark it "failed" and escalate instead of retrying
 * again on the next minute's tick.
 */
const MAX_DELIVERY_ATTEMPTS = 5;

interface ScheduledMessageDoc {
	_id: unknown;
	missionId: string;
	to: string[];
	subject: string;
	body: string;
	deliverAt: Date;
	cron?: string;
	label?: string;
	status: "pending" | "delivered" | "cancelled" | "failed";
	deliveryAttempts?: number;
}

interface MissionDoc {
	_id: unknown;
	missionId: string;
	machineId?: string;
	status: string;
	userId?: string;
	teamConfigYaml?: string;
}

/**
 * Record a permanently-failed scheduled delivery as a mission anomaly.
 * Builds a fresh, mission-scoped AnomalyRecorder per call rather than
 * threading one through the whole tick — this loop handles messages across
 * many missions/users in one pass, and a failure is rare enough that the
 * extra per-call setup (matching daemon.ts's own boot-time construction) is
 * cheap next to a genuinely broken schedule.
 */
async function recordSchedulingFailure(
	db: Db,
	missionsCol: Collection<MissionDoc>,
	doc: ScheduledMessageDoc,
	message: string,
): Promise<void> {
	const mission = await missionsCol.findOne({ missionId: doc.missionId });
	let missionCopilotAgentId: string | undefined;
	try {
		const teamConfig = mission?.teamConfigYaml
			? parseTeamConfig(mission.teamConfigYaml)
			: undefined;
		missionCopilotAgentId = teamConfig?.agents.some(
			(a) => a.id === MISSION_COPILOT_AGENT_ID,
		)
			? MISSION_COPILOT_AGENT_ID
			: undefined;
	} catch (e) {
		console.error(
			`[scheduler] Failed to parse teamConfigYaml for ${doc.missionId}: ${(e as Error).message}`,
		);
	}
	const anomalyRecorder = createMongoAnomalyRecorder(
		db,
		createMongoMailboxRepository(db, doc.missionId),
		missionCopilotAgentId,
		mission?.userId
			? {
					mailboxRepo: createMongoMailboxRepository(
						db,
						`copilot-${mission.userId}`,
					),
					missionId: `copilot-${mission.userId}`,
				}
			: undefined,
	);
	await anomalyRecorder.record({
		missionId: doc.missionId,
		category: "scheduling-failure",
		severity: "hard",
		message,
	});
}

// Exported for unit testing (deliver's attempt-cap/escalation logic) —
// mirrors why job-recovery.ts's recoverOrphanedJobs is exported separately
// from daemon.ts.
export async function deliver(db: Db): Promise<void> {
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

			// Deliver to mailbox. Fields must match MailboxMessage
			// (agent-runtime-worker/src/mailbox.ts) exactly — this insert
			// bypasses the shared repository, so nothing enforces that at the
			// type level. A prior version used createdAt/read instead of
			// timestamp/readBy: prompt.ts's formatMessages() calls
			// m.timestamp.toISOString() unconditionally, so a message missing
			// timestamp crashes the receiving agent's very next dispatch with
			// "Cannot read properties of undefined (reading 'toISOString')" —
			// found live when a mission copilot's CreateScheduledMessage first
			// exercised this delivery path for a real mission.
			await mailboxCol.insertOne({
				id: randomUUID(),
				missionId: doc.missionId,
				from: "scheduler",
				to: doc.to,
				subject: doc.subject,
				body: doc.body,
				timestamp: new Date(),
				readBy: [],
			});
			console.log(
				`[scheduler] Delivered "${doc.subject}" to ${doc.to.join(", ")} (mission ${doc.missionId})`,
			);
		} catch (e) {
			const attempts = (doc.deliveryAttempts ?? 0) + 1;
			console.error(
				`[scheduler] Failed to deliver message (attempt ${attempts}/${MAX_DELIVERY_ATTEMPTS}): ${(e as Error).message}`,
			);
			if (attempts > MAX_DELIVERY_ATTEMPTS) {
				await scheduledCol.updateOne(
					{ _id: doc._id },
					{ $set: { status: "failed", deliveryAttempts: attempts } },
				);
				const message =
					`Scheduled message "${doc.subject}" (to ${doc.to.join(", ")}) failed to ` +
					`deliver ${attempts - 1} time(s) in a row and will NOT be retried again. ` +
					`Last error: ${(e as Error).message}. It has been marked "failed" — ` +
					`investigate (e.g. is the mission's execution machine gone?) and re-create ` +
					`the schedule if it's still needed.`;
				await recordSchedulingFailure(db, missionsCol, doc, message).catch(
					(recordErr: Error) =>
						console.error(
							`[scheduler] Failed to record scheduling-failure anomaly: ${recordErr.message}`,
						),
				);
			} else {
				// Re-open for the next tick — NOT immediately. Without pushing
				// deliverAt forward, the while(true) loop below would re-claim
				// this same still-due message on its very next iteration and burn
				// all MAX_DELIVERY_ATTEMPTS in a rapid-fire loop within this one
				// call, which defeats the point of spacing retries out: a
				// genuinely transient failure (a momentary Mongo hiccup) needs
				// real wall-clock time to clear, not milliseconds. One minute
				// matches the tick cadence (`schedule("* * * * *", tick)`) one
				// stack frame up.
				const retryAt = new Date(now.getTime() + 60_000);
				await scheduledCol.updateOne(
					{ _id: doc._id },
					{
						$set: {
							status: "pending",
							deliveryAttempts: attempts,
							deliverAt: retryAt,
						},
					},
				);
			}
			continue;
		}

		// Re-arm cron-based entries.
		if (doc.cron) {
			try {
				const next = parseExpression(doc.cron).next().toDate();
				await scheduledCol.updateOne(
					{ _id: doc._id },
					// Reset deliveryAttempts on a successful delivery — otherwise a
					// past failure episode that self-healed would carry over into
					// this occurrence's count and reach MAX_DELIVERY_ATTEMPTS early.
					{ $set: { status: "pending", deliverAt: next, deliveryAttempts: 0 } },
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
