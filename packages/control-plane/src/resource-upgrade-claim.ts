/** The one-resize-at-a-time claim on a mission, and the failure path that releases it (ADR-0031). */

import { type MissionDoc, storedCollection } from "@magi/agent-config";
import type { Db } from "mongodb";
import { volumeExists } from "./fly-machines.js";
import {
	ResizeError,
	restartOnCurrentConfigTracked,
} from "./machine-lifecycle.js";
import { closeOpenSegments } from "./machine-segments.js";
import {
	cancelReminder,
	notify,
	recordAnomaly,
} from "./resource-upgrade-notify.js";

export interface UpgradeResult {
	status: number;
	body: Record<string, unknown>;
}

export const fail = (status: number, error: string): UpgradeResult => ({
	status,
	body: { error },
});

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

export const missionsOf = (db: Db) => storedCollection(db, "missions");

/** Take the one-resize-at-a-time claim; null if the mission is not running or already claimed. */
export async function claim(
	db: Db,
	missionId: string,
	now: Date,
): Promise<MissionDoc | null> {
	return missionsOf(db).findOneAndUpdate(
		{
			missionId,
			status: "running",
			"resize.claimedAt": { $exists: false },
		},
		{ $set: { "resize.claimedAt": now } },
		{ returnDocument: "after" },
	);
}

/**
 * Release a failed resize. `expectClaimedAt` (the stale-claim sweeper) makes
 * it a compare-and-set: if the claim it saw has since completed or been
 * replaced, nothing is changed (RU4 — a slow resize was otherwise failed
 * underneath itself).
 *
 * A failure after the stop step used to leave the mission in `error` with no
 * machine until the operator resumed it — at night, for hours, the
 * memory-starved mission that asked for the upgrade then could not run at
 * all (ai-news-digest, 2026-11-13: the volume's server had no room for the
 * bigger machine). Now the mission is brought back on its default machine
 * the way an operator resume does (restore below); `error` remains only when
 * that fails too. The sweeper's stale claims are not restored: the resize
 * they abandon may still be running.
 */
export async function failResize(
	db: Db,
	mission: MissionDoc,
	err: unknown,
	verb: string,
	expectClaimedAt?: Date,
): Promise<UpgradeResult> {
	const message = (err as Error).message;
	const stage = err instanceof ResizeError ? err.stage : "provision";
	if (stage === "stop") {
		// The old machine is still running: nothing changed, just let go of the claim.
		await missionsOf(db).updateOne(
			{ missionId: mission.missionId },
			{ $unset: { "resize.claimedAt": "" } },
		);
		return fail(
			502,
			`Could not ${verb}: the machine did not stop (${message}). Nothing changed.`,
		);
	}
	const errorMessage = `Machine resize failed at the ${stage} step (${message}). The workspace volume is intact; Resume the mission to start it on the default machine.`;
	const released = await missionsOf(db).updateOne(
		{
			missionId: mission.missionId,
			...(expectClaimedAt ? { "resize.claimedAt": expectClaimedAt } : {}),
		},
		{
			$set: { status: "error", errorMessage, updatedAt: new Date() },
			$unset: { upgrade: "", "resize.claimedAt": "" },
		},
	);
	if (expectClaimedAt && released.matchedCount === 0) {
		console.warn(
			`[resource-upgrade] stale resize claim changed before it could be released — left alone { missionId: "${mission.missionId}" }`,
		);
		return fail(409, "The resize claim changed before it could be released.");
	}
	await closeOpenSegments(db, mission.missionId).catch((e: unknown) =>
		console.error(
			`[resource-upgrade] could not close the runtime segment { missionId: "${mission.missionId}", error: "${(e as Error).message}" } — the next segment reconcile closes it`,
		),
	);
	await cancelReminder(db, mission.missionId, mission.upgrade?.reminderId);

	const restored = expectClaimedAt ? null : await restore(db, mission);
	const report = restored?.ok
		? `Could not ${verb} at the ${stage} step (${message}). The mission was restarted on its default machine (${restored.how}, ${restored.machineId}); whatever needed the bigger machine is still there — consider a permanent size (mission.memoryMb) with the operator.`
		: restored
			? `${errorMessage} Restarting it on the default machine also failed: ${restored.error}`
			: errorMessage;
	await recordAnomaly(db, mission, "resize-failure", report).catch(
		(e: unknown) =>
			console.error(
				`[resource-upgrade] could not record the resize-failure anomaly { missionId: "${mission.missionId}", error: "${(e as Error).message}" } — the copilots are not woken; the requester and operator are still mailed`,
			),
	);
	await notify(
		db,
		mission,
		mission.upgrade?.requestedByAgentId,
		restored?.ok
			? "Machine resize failed — back on the default machine"
			: "Machine resize failed",
		report,
	);
	console.error(
		`[resource-upgrade] Resize failed { missionId: "${mission.missionId}", stage: "${stage}", error: "${message}", restored: ${restored?.ok ?? "not attempted"} }`,
	);
	return fail(restored?.ok ? 502 : 500, report);
}

type Restore =
	| { ok: true; how: string; machineId: string }
	| { ok: false; error: string };

/**
 * Bring the mission back on its default machine after a failed resize, as an
 * operator resume would: the stopped machine updated in place when it still
 * exists, else a new machine on the volume, or on a fork of it in another
 * zone when the volume's server is full (restartOnCurrentConfigTracked).
 */
async function restore(db: Db, mission: MissionDoc): Promise<Restore> {
	const { missionId, machineId, volumeId } = mission;
	if (!machineId || !volumeId) {
		return { ok: false, error: "the mission records no machine or volume" };
	}
	try {
		if (!(await volumeExists(volumeId))) {
			return { ok: false, error: `volume ${volumeId} does not exist on Fly` };
		}
		const handle = await restartOnCurrentConfigTracked(db, {
			missionId,
			machineId,
			volumeId,
			mission: mission.mission,
		});
		await missionsOf(db).updateOne(
			{ missionId },
			{
				$set: {
					machineId: handle.machineId,
					privateIp: handle.privateIp,
					status: "running",
					"resize.lastAt": new Date(),
					updatedAt: new Date(),
				},
				$unset: { errorMessage: "" },
			},
		);
		return { ok: true, how: handle.how, machineId: handle.machineId };
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}
