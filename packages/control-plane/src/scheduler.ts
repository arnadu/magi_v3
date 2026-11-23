/**
 * Control-plane scheduled tasks.
 *
 * 1. Scheduled message delivery — every minute:
 *      Find scheduled_messages where deliverAt <= now && status == "pending".
 *      For each: look up the mission's machineId, resume the machine if stopped,
 *      insert the message into mailbox, mark delivered, re-arm cron entries.
 *
 * 2. Log retention pruning — every 30 minutes:
 *      Strip llmCallLog call bodies after LOG_BODY_RETENTION_DAYS and delete rows
 *      after LOG_ROW_RETENTION_DAYS, falling back to deleting when a strip is
 *      refused — see pruneOldLogEntries.
 */

import {
	entryTrigger,
	type MissionDoc,
	type ScheduledMessageDoc,
	storedCollection,
} from "@magi/agent-config";
import {
	createMongoAnomalyRecorder,
	createMongoMailboxRepository,
	MISSION_COPILOT_AGENT_ID,
} from "@magi/agent-runtime-worker";
import cronParser from "cron-parser";
import type { Collection, Db, WithId } from "mongodb";
import { schedule } from "node-cron";
import { getMachineState } from "./fly-machines.js";
import { wakeTracked } from "./machine-lifecycle.js";
import { postMailbox } from "./mailbox-writer.js";
import { relayToPlatformAdmins } from "./platform-relay.js";
import { createUpgradeSweeper } from "./resource-upgrade.js";

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
	doc: WithId<ScheduledMessageDoc>,
	message: string,
): Promise<void> {
	const mission = await missionsCol.findOne({ missionId: doc.missionId });
	const missionCopilotAgentId = mission?.agents?.some(
		(a) => a.id === MISSION_COPILOT_AGENT_ID,
	)
		? MISSION_COPILOT_AGENT_ID
		: undefined;
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

/**
 * Wake the execution plane machine before a delivery if it is stopped — or
 * gone: a missing machine (getMachineState 404 → "unknown") is re-provisioned
 * on the mission's volume by wakeTracked rather than failing the delivery
 * five times and marking the schedule failed. A resize in flight has the
 * machine stopped on purpose; the message still lands in the mailbox and the
 * re-created machine reads it on boot.
 */
async function wakeIfNotRunning(db: Db, mission: MissionDoc): Promise<void> {
	if (!mission.machineId || mission.resize?.claimedAt) return;
	const state = await getMachineState(mission.machineId).catch(() => "unknown");
	if (state === "started" || state === "starting") return;
	console.log(
		`[scheduler] Waking machine ${mission.machineId} (state ${state}) for mission ${mission.missionId}`,
	);
	await wakeTracked(db, {
		missionId: mission.missionId,
		machineId: mission.machineId,
		volumeId: mission.volumeId,
		mission: mission.mission,
	});
}

// Exported for unit testing (deliver's attempt-cap/escalation logic) —
// mirrors why job-recovery.ts's recoverOrphanedJobs is exported separately
// from daemon.ts.
/** A claim older than this with no outcome belongs to a tick that died mid-delivery; it is re-opened (SCH1). */
export const DELIVERY_LEASE_MS = 5 * 60_000;
/**
 * One delivery (wake the machine, then post the mail or flag the job) may take
 * this long; past it, it counts as a failed attempt and is retried next tick.
 * Without it one hung call held up every mission's schedules: on 2026-11-23 a
 * delivery loop stalled from about 20:15 to 20:54 UTC.
 */
export const DELIVERY_TIMEOUT_MS = 3 * 60_000;
/** A tick still running after this long is reported as a stall (once per stalled tick). */
export const DELIVERY_STALL_MS = 5 * 60_000;
let deliverStartedAt: number | null = null;
let stallReported = false;

export interface DeliverOptions {
	/** Told once when a tick has been running longer than DELIVERY_STALL_MS. */
	onStall?: (runningMs: number) => void;
	now?: () => number;
	/** Injected for tests; DELIVERY_TIMEOUT_MS otherwise. */
	deliveryTimeoutMs?: number;
}

export async function deliver(
	db: Db,
	opts: DeliverOptions = {},
): Promise<void> {
	const now = opts.now ?? Date.now;
	// A slow tick (Fly wake-ups take tens of seconds) used to overlap the next
	// one and both worked the same queue (SCH5): the next tick is skipped, and a
	// skip that goes on is a stall, reported.
	if (deliverStartedAt !== null) {
		const runningMs = now() - deliverStartedAt;
		if (runningMs > DELIVERY_STALL_MS && !stallReported) {
			stallReported = true;
			opts.onStall?.(runningMs);
		}
		return;
	}
	deliverStartedAt = now();
	stallReported = false;
	try {
		await deliverAll(db, opts.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS);
	} finally {
		deliverStartedAt = null;
	}
}

/** One claimed entry: wake its mission's machine, then post the mail or flag the job for the daemon. */
async function deliverOne(
	db: Db,
	doc: WithId<ScheduledMessageDoc>,
): Promise<void> {
	const mission = await storedCollection(db, "missions").findOne({
		missionId: doc.missionId,
	});
	if (mission) await wakeIfNotRunning(db, mission);
	if (doc.kind === "job") {
		await storedCollection(db, "scheduledMessages").updateOne(
			{ _id: doc._id },
			{
				$set: {
					pendingFire: { dueAt: doc.deliverAt, requestedAt: new Date() },
				},
			},
		);
		console.log(
			`[scheduler] Job schedule "${doc.label ?? doc.subject}" due — flagged for the mission daemon (mission ${doc.missionId})`,
		);
	} else {
		await deliverToMailbox(db, doc);
	}
}

/** Rejects after `ms`; the work itself is not cancelled, only no longer waited for. */
function withTimeout<T>(
	work: Promise<T>,
	ms: number,
	what: string,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`${what} took longer than ${ms / 1000} s`)),
			ms,
		);
	});
	return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Leases abandoned by a crashed or redeployed control plane go back to
 * pending: at-least-once, where the old claim-as-delivered was at-most-once
 * and lost the message — and, for a cron entry, the recurrence (SCH1).
 */
async function reopenStaleLeases(
	scheduledCol: Collection<ScheduledMessageDoc>,
	now: Date,
): Promise<void> {
	await scheduledCol.updateMany(
		{
			status: "delivering",
			claimedAt: { $lt: new Date(now.getTime() - DELIVERY_LEASE_MS) },
		},
		{ $set: { status: "pending" } },
	);
}

/** Deliver a due scheduled message to the mailbox through the shared writer. */
async function deliverToMailbox(
	db: Db,
	doc: WithId<ScheduledMessageDoc>,
): Promise<void> {
	await postMailbox(db, {
		missionId: doc.missionId,
		from: "scheduler",
		to: doc.to,
		subject: doc.subject,
		body: doc.body,
	});
	console.log(
		`[scheduler] Delivered "${doc.subject}" to ${doc.to.join(", ")} (mission ${doc.missionId})`,
	);
}

async function deliverAll(db: Db, timeoutMs: number): Promise<void> {
	const scheduledCol = storedCollection(db, "scheduledMessages");
	const missionsCol = storedCollection(db, "missions");

	const now = new Date();

	await reopenStaleLeases(scheduledCol, now);

	while (true) {
		// Atomically claim one pending message under a lease.
		const doc = await scheduledCol.findOneAndUpdate(
			{ status: "pending", deliverAt: { $lte: now } },
			{ $set: { status: "delivering", claimedAt: now } },
		);
		if (!doc) break;

		try {
			await withTimeout(
				deliverOne(db, doc),
				timeoutMs,
				`delivering "${doc.label ?? doc.subject}" (mission ${doc.missionId})`,
			);
			if (!doc.cron) {
				await scheduledCol.updateOne(
					{ _id: doc._id },
					{ $set: { status: "delivered", deliveredAt: new Date() } },
				);
			}
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
				// UTC, matching how the daemon arms a schedule file's first fire
				// (mission-copilot-schedule-input.ts); on Fly the process TZ is UTC
				// anyway, this makes local dev agree.
				const next = parseExpression(doc.cron, { tz: "UTC" }).next().toDate();
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

// Call bodies (input/output) are kept 1 day: they are ~135 KB a call, and on
// the M0 tier they twice filled the cluster (2026-08-09/10, with an
// O(n²) input.messages bug fixed separately in llm-call-log.ts). The rest of
// a row — model, tokens, cost, timing, a few hundred bytes — is kept 90 days,
// so a spend question ("where did last night's credits go?") can still be
// answered after the fact (LL1).
const LOG_BODY_RETENTION_DAYS = 1;
const LOG_ROW_RETENTION_DAYS = 90;

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

/**
 * Strip call bodies past their window, delete rows past theirs. Stripping is
 * an update, and Atlas blocks *all* writes at a hard storage quota, shrinking
 * ones included, while deleteMany still works (seen live, twice, on M0) — so
 * if the strip fails, rows past the body window are deleted instead, and the
 * pruner can always dig out. Spend totals do not depend on this collection:
 * missionStats/agentTurnStats hold them (agent-stats.ts). Runs on startup and
 * every 30 minutes.
 */
export async function pruneOldLogEntries(db: Db): Promise<void> {
	const col = storedCollection(db, "llmCallLog");
	const bodyCutoff = daysAgo(LOG_BODY_RETENTION_DAYS);
	try {
		const stripped = await col.updateMany(
			{ savedAt: { $lt: bodyCutoff }, input: { $exists: true } },
			{ $unset: { input: "", output: "" } },
		);
		if (stripped.modifiedCount > 0) {
			console.log(
				`[scheduler] Log pruning: stripped bodies from ${stripped.modifiedCount} entries older than ${LOG_BODY_RETENTION_DAYS} day(s)`,
			);
		}
	} catch (e) {
		const deleted = await col.deleteMany({ savedAt: { $lt: bodyCutoff } });
		console.error(
			`[scheduler] Log pruning: stripping bodies failed (${(e as Error).message}) — deleted ${deleted.deletedCount} entries older than ${LOG_BODY_RETENTION_DAYS} day(s) instead; their usage rows are lost, spend totals are not`,
		);
	}
	const deleted = await col.deleteMany({
		savedAt: { $lt: daysAgo(LOG_ROW_RETENTION_DAYS) },
	});
	if (deleted.deletedCount > 0) {
		console.log(
			`[scheduler] Log pruning: deleted ${deleted.deletedCount} entries older than ${LOG_ROW_RETENTION_DAYS} days`,
		);
	}
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/** Start the scheduled delivery heartbeat and log pruner. Returns a stop function. */
export function startScheduler(
	db: Db,
	opts: { platformAdminUserIds: readonly string[] } = {
		platformAdminUserIds: [],
	},
): () => void {
	const onStall = (runningMs: number) => {
		const minutes = Math.round(runningMs / 60_000);
		const body = `Scheduled delivery has been stuck for ${minutes} min: one tick is still running, so every mission's scheduled messages and jobs are waiting. Each delivery is limited to ${DELIVERY_TIMEOUT_MS / 60_000} min, so a stall this long points at the database or the claim loop itself; see the control plane's [scheduler] log.`;
		console.error(
			`[scheduler] Delivery stalled { runningMin: ${minutes} } — ${body}`,
		);
		void relayToPlatformAdmins(db, opts.platformAdminUserIds, {
			category: "scheduler-stall",
			body,
		});
	};
	const tick = () =>
		deliver(db, { onStall }).catch((e) =>
			console.error(
				`[scheduler] Delivery tick failed: ${(e as Error).message} — the next tick retries`,
			),
		);

	const prune = () =>
		pruneOldLogEntries(db).catch((e) =>
			console.error("[scheduler] Pruning error:", e),
		);

	// Revert expired temporary machine upgrades (ADR-0031). Also run at startup,
	// so an outage that spanned an expiry reverts late rather than never.
	const sweepUpgrades = createUpgradeSweeper(db);
	void sweepUpgrades();

	// Deliver any overdue messages immediately on startup.
	tick();
	// Prune any stale log entries immediately on startup (catches missed days).
	prune();

	const deliveryTask = schedule(
		"* * * * *",
		entryTrigger("schedule.deliver", tick),
	);
	const upgradeSweepTask = schedule(
		"* * * * *",
		entryTrigger("machine.upgrade", () => void sweepUpgrades()),
	);
	// Every 30 minutes — was daily at 02:00 UTC, too slow to catch fast
	// accumulation on a busy mission before it reached the Atlas quota.
	const pruneTask = schedule(
		"*/30 * * * *",
		entryTrigger("housekeeping", prune),
	);

	return () => {
		deliveryTask.stop();
		upgradeSweepTask.stop();
		pruneTask.stop();
	};
}
