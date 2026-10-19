/** The one-resize-at-a-time claim on a mission, and the failure path that releases it (ADR-0031). */

import { type MissionDoc, storedCollection } from "@magi/agent-config";
import type { Db } from "mongodb";
import { ResizeError } from "./machine-lifecycle.js";
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

export async function failResize(
	db: Db,
	mission: MissionDoc,
	err: unknown,
	verb: string,
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
	await missionsOf(db).updateOne(
		{ missionId: mission.missionId },
		{
			$set: { status: "error", errorMessage, updatedAt: new Date() },
			$unset: { upgrade: "", "resize.claimedAt": "" },
		},
	);
	await closeOpenSegments(db, mission.missionId).catch((e: unknown) =>
		console.error(
			`[resource-upgrade] could not close the runtime segment { missionId: "${mission.missionId}", error: "${(e as Error).message}" } — the next segment reconcile closes it`,
		),
	);
	await cancelReminder(db, mission.missionId, mission.upgrade?.reminderId);
	await recordAnomaly(db, mission, "resize-failure", errorMessage).catch(
		() => {},
	);
	await notify(
		db,
		mission,
		mission.upgrade?.requestedByAgentId,
		"Machine resize failed",
		errorMessage,
	);
	console.error(
		`[resource-upgrade] Resize failed { missionId: "${mission.missionId}", stage: "${stage}", error: "${message}" }`,
	);
	return fail(500, errorMessage);
}
