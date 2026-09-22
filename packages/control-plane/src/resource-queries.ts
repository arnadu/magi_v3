/**
 * Small shared Mongo reads behind the resource-oversight tick (`resource-monitor.ts`)
 * and the daily report (`resource-report.ts`) — kept in one place so both read
 * `missionResources`/`missionStats`/`agentTurnStats` the same way.
 */

import type { Db } from "mongodb";

/** Sum of `agentTurnStats.costUsd` for turns starting in `[from, to)`, across every agent. */
export async function sumTurnCostUsd(
	db: Db,
	missionId: string,
	from: Date,
	to: Date,
): Promise<number> {
	const [row] = await db
		.collection("agentTurnStats")
		.aggregate<{ total: number }>([
			{ $match: { missionId, startedAt: { $gte: from, $lt: to } } },
			{ $group: { _id: null, total: { $sum: "$costUsd" } } },
		])
		.toArray();
	return row?.total ?? 0;
}

/** The latest turn activity for any agent in the mission, or null if none has ever run. */
export async function lastActivityAt(
	db: Db,
	missionId: string,
): Promise<Date | null> {
	const rows = await db
		.collection<{ lastTurnAt: Date }>("missionStats")
		.find({ missionId }, { projection: { lastTurnAt: 1 } })
		.toArray();
	if (rows.length === 0) return null;
	return rows.reduce(
		(max, r) => (r.lastTurnAt > max ? r.lastTurnAt : max),
		rows[0].lastTurnAt,
	);
}

export interface MissionResourceSample {
	diskUsedBytes?: number;
	diskTotalBytes?: number;
	runningJobs?: number;
	updatedAt?: Date;
}

/** The disk sampler's latest reading for the mission, or null if none exists yet. */
export async function latestResourceSample(
	db: Db,
	missionId: string,
): Promise<MissionResourceSample | null> {
	return db.collection<MissionResourceSample>("missionResources").findOne(
		{ missionId },
		{
			projection: {
				diskUsedBytes: 1,
				diskTotalBytes: 1,
				runningJobs: 1,
				updatedAt: 1,
			},
		},
	);
}
