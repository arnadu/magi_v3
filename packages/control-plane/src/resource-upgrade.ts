/**
 * Temporary mission-machine upgrades (ADR-0031): request, renew, revert, the
 * expiry sweeper, and suspend-with-revert.
 *
 * A resize stops the mission's machine and re-creates it on the same volume,
 * the same hard interruption as a manual suspend. The mission document holds
 * the state:
 *
 *   upgrade  — present while the mission is on an upgraded machine
 *   resize   — `claimedAt` while a resize is in flight (one at a time; a
 *              stale claim means the resize died and is recovered by the
 *              sweeper), `lastAt` for the cooldown between shape changes
 *
 * Everything the caller supplies is untrusted: the shape and duration are
 * validated (machine-shapes.ts), `reason` is capped and stripped of control
 * characters, and `requestedByAgentId` must be on the mission's roster.
 * Notifications are posted from here, not by the tool that asked, because the
 * requesting daemon is stopped by the resize itself.
 */

import type { MissionDoc, MissionUpgradeState } from "@magi/agent-config";
import { UPGRADE_LIMITS } from "@magi/agent-runtime-worker";
import type { Db } from "mongodb";
import { isLocalExecution } from "./fly-machines.js";
import {
	ResizeError,
	resizeTracked,
	suspendTracked,
} from "./machine-lifecycle.js";
import {
	closeOpenSegments,
	defaultShapeOf,
	setPlannedEnd,
	upgradedMsSince,
} from "./machine-segments.js";
import {
	type MachineShape,
	sameShape,
	validateUpgradeRequest,
} from "./machine-shapes.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export type { MissionUpgradeState };

import {
	claim,
	fail,
	failResize,
	missionsOf,
	type UpgradeResult,
} from "./resource-upgrade-claim.js";
import {
	cancelReminder,
	describeShape,
	notify,
	recordCapReached,
	sanitizeReason,
	scheduleReminder,
	utc,
} from "./resource-upgrade-notify.js";

export { sanitizeReason };
export type { UpgradeResult };

// ---------------------------------------------------------------------------
// Request / renew
// ---------------------------------------------------------------------------

/** Request a temporary upgrade, or renew the current one when the shape is unchanged. */
interface AdmittedRequest {
	mission: MissionDoc;
	shape: MachineShape;
	durationMinutes: number;
	reason: string;
	requester: string | undefined;
}

/** Everything that can refuse a request before any accounting: input, reason, requester, deployment, state, shape. */
async function admitRequest(
	db: Db,
	missionId: string,
	input: unknown,
): Promise<AdmittedRequest | UpgradeResult> {
	const validated = validateUpgradeRequest(input);
	if (!validated.ok) return fail(400, validated.error);
	const { durationMinutes, ...shape } = validated.request;
	const body = (input ?? {}) as Record<string, unknown>;
	const reason = sanitizeReason(body.reason);
	if (!reason)
		return fail(400, "reason is required: say what needs the bigger machine.");
	const mission = await missionsOf(db).findOne({ missionId });
	if (!mission) return fail(404, "Mission not found.");
	const requester = body.requestedByAgentId;
	if (
		requester !== undefined &&
		(typeof requester !== "string" ||
			!(mission.agents ?? []).some((a) => a.id === requester))
	) {
		return fail(400, "requestedByAgentId is not an agent of this mission.");
	}
	if (mission.machineId?.startsWith("local-") || isLocalExecution()) {
		return fail(
			501,
			"Machine upgrades need a Fly deployment; this is local execution.",
		);
	}
	if (mission.status !== "running" || !mission.machineId || !mission.volumeId) {
		return fail(409, `The mission is not running (status: ${mission.status}).`);
	}
	if (sameShape(shape, defaultShapeOf(mission))) {
		return fail(
			400,
			"That is the mission's default machine; no upgrade is needed.",
		);
	}
	return {
		mission,
		shape,
		durationMinutes,
		reason,
		requester: typeof requester === "string" ? requester : undefined,
	};
}

/** A refusal while the last resize is within the cooldown, or null. */
function cooldownRefusal(mission: MissionDoc, now: Date): UpgradeResult | null {
	const lastAt = mission.resize?.lastAt;
	const cooldownMs = UPGRADE_LIMITS.resizeCooldownMinutes * MINUTE;
	if (!lastAt || now.getTime() - lastAt.getTime() >= cooldownMs) return null;
	const wait = Math.ceil(
		(cooldownMs - (now.getTime() - lastAt.getTime())) / 1000,
	);
	return fail(
		429,
		`The machine was resized less than ${UPGRADE_LIMITS.resizeCooldownMinutes} minutes ago; retry in about ${wait} s.`,
	);
}

/** Replace the claimed machine with the bigger shape and record the upgrade; a failure releases the claim. */
async function applyUpgrade(
	db: Db,
	claimed: MissionDoc & { machineId: string; volumeId: string },
	upgrade: MissionUpgradeState,
	now: Date,
): Promise<UpgradeResult | null> {
	const { missionId } = claimed;
	const shape = {
		cpuKind: upgrade.cpuKind,
		cpus: upgrade.cpus,
		memoryMb: upgrade.memoryMb,
	};
	try {
		const handle = await resizeTracked(
			db,
			{ missionId, machineId: claimed.machineId, volumeId: claimed.volumeId },
			shape,
			{
				upgraded: true,
				plannedEndAt: upgrade.expiresAt,
				requestedByAgentId: upgrade.requestedByAgentId,
			},
		);
		await cancelReminder(db, missionId, claimed.upgrade?.reminderId);
		upgrade.reminderId = await scheduleReminder(db, claimed, upgrade, now);
		await missionsOf(db).updateOne(
			{ missionId },
			{
				$set: {
					machineId: handle.machineId,
					privateIp: handle.privateIp,
					upgrade,
					"resize.lastAt": now,
					updatedAt: now,
				},
				$unset: { "resize.claimedAt": "" },
			},
		);
		return null;
	} catch (e) {
		return failResize(db, claimed, e, "upgrade the machine");
	}
}

export async function requestUpgrade(
	db: Db,
	missionId: string,
	input: unknown,
	now: Date = new Date(),
): Promise<UpgradeResult> {
	const admitted = await admitRequest(db, missionId, input);
	if ("status" in admitted) return admitted;
	const { mission, shape, durationMinutes, reason, requester } = admitted;
	const since = mission.upgradedRuntimeResetAt ?? new Date(0);
	const capMs = UPGRADE_LIMITS.cumulativeCapHours * HOUR;
	const newExpiry = new Date(now.getTime() + durationMinutes * MINUTE);

	if (mission.upgrade && sameShape(shape, mission.upgrade)) {
		return renew(db, mission, mission.upgrade, {
			since,
			capMs,
			newExpiry,
			reason,
			requester,
			now,
		});
	}

	// A shape change: the current window (if any) ends now, so it counts as elapsed.
	const used = await upgradedMsSince(db, missionId, since, now, "elapsed");
	if (used + durationMinutes * MINUTE > capMs) {
		const message = `The cumulative upgraded-runtime cap of ${UPGRADE_LIMITS.cumulativeCapHours} h is reached (${(used / HOUR).toFixed(1)} h used; this request needs ${(durationMinutes / 60).toFixed(2)} h more). Only the operator can reset it, in the cockpit Limits panel.`;
		await recordCapReached(db, mission, message);
		return fail(403, message);
	}
	const cooling = cooldownRefusal(mission, now);
	if (cooling) return cooling;

	const claimed = await claim(db, missionId, now);
	if (!claimed?.machineId || !claimed.volumeId) {
		return fail(409, "Another resize is already in progress for this mission.");
	}
	const upgrade: MissionUpgradeState = {
		...shape,
		expiresAt: newExpiry,
		...(requester && { requestedByAgentId: requester }),
	};
	const failed = await applyUpgrade(
		db,
		{ ...claimed, machineId: claimed.machineId, volumeId: claimed.volumeId },
		upgrade,
		now,
	);
	if (failed) return failed;

	await notify(
		db,
		claimed,
		upgrade.requestedByAgentId,
		"Machine upgraded",
		`The mission's machine was replaced by a bigger one (${describeShape(shape)}) until ${utc(newExpiry)} (${durationMinutes} min)${upgrade.requestedByAgentId ? `, requested by ${upgrade.requestedByAgentId}` : ""}. Reason given: ${reason}\n\nThe machine restarted: running agent turns were interrupted and background jobs will re-run from scratch. Renew before ${utc(newExpiry)} if the work needs longer; otherwise the machine reverts to the default.`,
	);
	return {
		status: 200,
		body: {
			ok: true,
			action: "upgraded",
			shape,
			expiresAt: newExpiry.toISOString(),
			message: `Upgraded to ${describeShape(shape)} until ${utc(newExpiry)}. The mission restarted; interrupted work will resume.`,
		},
	};
}

async function renew(
	db: Db,
	mission: MissionDoc,
	current: MissionUpgradeState,
	o: {
		since: Date;
		capMs: number;
		newExpiry: Date;
		reason: string;
		requester: string | undefined;
		now: Date;
	},
): Promise<UpgradeResult> {
	// The current window already counts to its planned end; only the change to that end is new.
	const used = await upgradedMsSince(
		db,
		mission.missionId,
		o.since,
		o.now,
		"committed",
	);
	const oldEnd = Math.max(current.expiresAt.getTime(), o.now.getTime());
	const total = used + (o.newExpiry.getTime() - oldEnd);
	if (total > o.capMs) {
		const message = `Renewing would exceed the cumulative upgraded-runtime cap of ${UPGRADE_LIMITS.cumulativeCapHours} h (${(used / HOUR).toFixed(1)} h already committed). Only the operator can reset it, in the cockpit Limits panel.`;
		await recordCapReached(db, mission, message);
		return fail(403, message);
	}

	const requester = o.requester ?? current.requestedByAgentId;
	const renewed: MissionUpgradeState = {
		...current,
		expiresAt: o.newExpiry,
		...(requester && { requestedByAgentId: requester }),
	};
	// Compare-and-set on the old expiry: if the sweeper or another request got
	// there first, this renewal must not resurrect an upgrade that just ended.
	const swapped = await missionsOf(db).findOneAndUpdate(
		{
			missionId: mission.missionId,
			status: "running",
			"upgrade.expiresAt": current.expiresAt,
			"resize.claimedAt": { $exists: false },
		},
		{
			$set: {
				"upgrade.expiresAt": o.newExpiry,
				...(requester && { "upgrade.requestedByAgentId": requester }),
			},
		},
		{ returnDocument: "after" },
	);
	if (!swapped) {
		return fail(
			409,
			"The upgrade changed while renewing (it may just have expired). Check the machine's state and retry.",
		);
	}
	await setPlannedEnd(db, mission.missionId, o.newExpiry).catch((e: unknown) =>
		console.error(
			`[resource-upgrade] could not extend the segment's planned end { missionId: "${mission.missionId}", error: "${(e as Error).message}" } — the upgrade cap counts the renewal only as it is used`,
		),
	);
	await cancelReminder(db, mission.missionId, current.reminderId);
	renewed.reminderId = await scheduleReminder(db, mission, renewed, o.now);
	await missionsOf(db).updateOne(
		{ missionId: mission.missionId },
		{ $set: { "upgrade.reminderId": renewed.reminderId ?? null } },
	);
	await notify(
		db,
		mission,
		requester,
		"Machine upgrade renewed",
		`The ${describeShape(current)} machine now runs until ${utc(o.newExpiry)} (no restart). Reason given: ${o.reason}`,
	);
	return {
		status: 200,
		body: {
			ok: true,
			action: "renewed",
			shape: {
				cpuKind: current.cpuKind,
				cpus: current.cpus,
				memoryMb: current.memoryMb,
			},
			expiresAt: o.newExpiry.toISOString(),
			message: `Renewed until ${utc(o.newExpiry)}; the machine was not restarted.`,
		},
	};
}

// ---------------------------------------------------------------------------
// Revert
// ---------------------------------------------------------------------------

export type RevertReason = "requested" | "expired" | "suspend";

/** Return a mission to its default machine. Expiry and suspend bypass the cooldown. */
export async function revertUpgrade(
	db: Db,
	missionId: string,
	opts: { reason: RevertReason; now?: Date },
): Promise<UpgradeResult> {
	const now = opts.now ?? new Date();
	const mission = await missionsOf(db).findOne({ missionId });
	if (!mission) return fail(404, "Mission not found.");
	if (!mission.upgrade)
		return fail(409, "The mission is not on an upgraded machine.");

	if (opts.reason === "requested") {
		const lastAt = mission.resize?.lastAt;
		if (
			lastAt &&
			now.getTime() - lastAt.getTime() <
				UPGRADE_LIMITS.resizeCooldownMinutes * MINUTE
		) {
			return fail(
				429,
				`The machine was resized less than ${UPGRADE_LIMITS.resizeCooldownMinutes} minutes ago; retry shortly.`,
			);
		}
	}

	const claimed = await claim(db, missionId, now);
	if (!claimed?.machineId || !claimed.volumeId || !claimed.upgrade) {
		return fail(409, "Another resize is already in progress for this mission.");
	}
	const previous = claimed.upgrade;
	const target = defaultShapeOf(claimed);
	try {
		const handle = await resizeTracked(
			db,
			{ missionId, machineId: claimed.machineId, volumeId: claimed.volumeId },
			target,
			{ upgraded: false },
		);
		await cancelReminder(db, missionId, previous.reminderId);
		await missionsOf(db).updateOne(
			{ missionId },
			{
				$set: {
					machineId: handle.machineId,
					privateIp: handle.privateIp,
					"resize.lastAt": now,
					updatedAt: now,
				},
				$unset: { upgrade: "", "resize.claimedAt": "" },
			},
		);
	} catch (e) {
		return failResize(db, claimed, e, "revert the machine");
	}

	const why =
		opts.reason === "expired"
			? "The upgrade window ended."
			: opts.reason === "suspend"
				? "The mission is being suspended."
				: "Reverted on request.";
	await notify(
		db,
		claimed,
		previous.requestedByAgentId,
		"Machine returned to the default",
		`${why} The mission's machine is back to the default (${describeShape(target)}). The machine restarted: running agent turns were interrupted and background jobs will re-run from scratch.`,
	);
	return {
		status: 200,
		body: {
			ok: true,
			action: "reverted",
			shape: target,
			message: `${why} Back on the default machine.`,
		},
	};
}

/**
 * Suspend a mission's machine. An upgraded mission is reverted first, so a
 * suspended mission's stopped machine is always the default shape and every
 * resume path (operator, copilot, scheduler wake-up) works unchanged.
 */
export async function suspendMissionMachine(
	db: Db,
	mission: { missionId: string; machineId: string },
): Promise<void> {
	let machineId = mission.machineId;
	const doc = await missionsOf(db).findOne({ missionId: mission.missionId });
	if (doc?.upgrade) {
		const r = await revertUpgrade(db, mission.missionId, { reason: "suspend" });
		if (r.status !== 200) {
			throw new Error(
				`Could not return the mission to its default machine before suspending: ${String(r.body.error)}`,
			);
		}
		const fresh = await missionsOf(db).findOne({
			missionId: mission.missionId,
		});
		if (!fresh?.machineId)
			throw new Error("Mission has no machine after reverting its upgrade.");
		machineId = fresh.machineId;
	}
	await suspendTracked(db, mission.missionId, machineId);
}

// ---------------------------------------------------------------------------
// Sweeper
// ---------------------------------------------------------------------------

/**
 * A runnable for the scheduler's tick: sweeps once, never overlaps itself (a
 * revert can outlast a minute), never throws, and logs only when it did
 * something.
 */
export function createUpgradeSweeper(db: Db): () => Promise<void> {
	let running = false;
	return async () => {
		if (running) return;
		running = true;
		try {
			const r = await sweepUpgrades(db);
			if (r.reverted || r.recovered || r.cleared) {
				console.log(
					`[resource-upgrade] Sweep { reverted: ${r.reverted}, recovered: ${r.recovered}, cleared: ${r.cleared} }`,
				);
			}
		} catch (e) {
			console.error(
				`[resource-upgrade] Sweep failed { error: "${(e as Error).message}" }`,
			);
		} finally {
			running = false;
		}
	};
}

export interface SweepResult {
	reverted: number;
	recovered: number;
	cleared: number;
}

/**
 * Run from the scheduler's 1-minute tick and once at startup, so an outage at
 * expiry reverts late, never not at all. Each mission is handled in
 * isolation.
 */
export async function sweepUpgrades(
	db: Db,
	now: Date = new Date(),
): Promise<SweepResult> {
	const col = missionsOf(db);
	const result: SweepResult = { reverted: 0, recovered: 0, cleared: 0 };
	const guarded = async (
		label: string,
		missionId: string,
		op: () => Promise<void>,
	) => {
		try {
			await op();
		} catch (e) {
			console.error(
				`[resource-upgrade] Sweep step failed { step: "${label}", missionId: "${missionId}", error: "${(e as Error).message}" }`,
			);
		}
	};

	// 1. Expired upgrades on running missions.
	const expired = await col
		.find({
			status: "running",
			"upgrade.expiresAt": { $lte: now },
			"resize.claimedAt": { $exists: false },
		})
		.toArray();
	for (const m of expired) {
		await guarded("revert-expired", m.missionId, async () => {
			const r = await revertUpgrade(db, m.missionId, {
				reason: "expired",
				now,
			});
			if (r.status === 200) result.reverted++;
		});
	}

	// 2. Resizes that died mid-flight (control plane restarted): the machine's state is unknown.
	const staleCutoff = new Date(
		now.getTime() - UPGRADE_LIMITS.staleClaimMinutes * MINUTE,
	);
	const stale = await col
		.find({ "resize.claimedAt": { $lt: staleCutoff } })
		.toArray();
	for (const m of stale) {
		await guarded("recover-stale-claim", m.missionId, async () => {
			await failResize(
				db,
				m,
				new ResizeError(
					"provision",
					"the resize did not complete (control plane restarted?)",
				),
				"resize the machine",
			);
			result.recovered++;
		});
	}

	// 3. Upgrade state left on a mission that is no longer running.
	const orphaned = await col
		.find({
			status: { $ne: "running" },
			upgrade: { $exists: true },
			"resize.claimedAt": { $exists: false },
		})
		.toArray();
	for (const m of orphaned) {
		await guarded("clear-orphaned", m.missionId, async () => {
			await col.updateOne(
				{ missionId: m.missionId },
				{ $unset: { upgrade: "" } },
			);
			await closeOpenSegments(db, m.missionId, now);
			await cancelReminder(db, m.missionId, m.upgrade?.reminderId);
			result.cleared++;
		});
	}
	return result;
}
