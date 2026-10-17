/**
 * The claims every mission launch/resume path makes before touching Fly
 * (LAUNCH1/LAUNCH2/EA5): a compare-and-set on `status`, the volume id
 * persisted the moment it exists, and an insert that lets the unique
 * `missionId` index settle a race. Kept apart from the router so the
 * invariant is one short file.
 */

import type { Response } from "express";
import type { Collection, Db } from "mongodb";
import type { MissionDoc } from "./missions.js";

/**
 * Compare-and-set on `missions.status` (LAUNCH1): the one claim every launch
 * and resume path makes before touching Fly, so a double click or a retried
 * request cannot provision twice for one mission id.
 */
export async function claimStatus(
	col: Collection<MissionDoc>,
	missionId: string,
	from: MissionDoc["status"],
	to: MissionDoc["status"],
): Promise<boolean> {
	const r = await col.updateOne(
		{ missionId, status: from },
		{ $set: { status: to, updatedAt: new Date() } },
	);
	return r.matchedCount === 1;
}

/** Records the volume id the moment Fly creates it (LAUNCH2), so a failure later in provisioning cannot orphan it. */
export function persistVolumeId(
	col: Collection<MissionDoc>,
	missionId: string,
): (volumeId: string) => Promise<void> {
	return async (volumeId) => {
		await col.updateOne(
			{ missionId },
			{ $set: { volumeId, updatedAt: new Date() } },
		);
	};
}

/**
 * Insert a new mission document; answers 409 and returns false when the
 * unique `missionId` index rejects it (two creates raced past the existence
 * check — EA5/LAUNCH1).
 */
export async function insertMissionOrConflict(
	col: Collection<MissionDoc>,
	doc: MissionDoc,
	res: Response,
): Promise<boolean> {
	try {
		await col.insertOne(doc);
		return true;
	} catch (e) {
		if ((e as { code?: number }).code === 11000) {
			res.status(409).json({ error: "Mission already exists" });
			return false;
		}
		throw e;
	}
}

/**
 * The mission id is the claim every launch path relies on. Creation fails if
 * duplicates already exist: that is a real inconsistency to fix
 * (scripts/reconcile-mission-state.mjs), not something to hide — so the
 * failure is logged loudly and startup continues.
 */
export async function ensureMissionIdIndex(db: Db): Promise<void> {
	await db
		.collection("missions")
		.createIndex({ missionId: 1 }, { unique: true })
		.catch((e: Error) =>
			console.error(
				`[control-plane] cannot create the unique missions.missionId index: ${e.message} — concurrent launches of one id are not prevented until the duplicates are removed`,
			),
		);
}
