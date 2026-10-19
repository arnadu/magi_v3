/**
 * The copilot's spend cap: lifetime spend from `missionStats` against the
 * user's cap. Used before every copilot turn — operator messages (router)
 * and autonomous wakeups (copilot daemon) alike.
 */

import {
	createMongoAgentStatsRepository,
	StatsCollector,
} from "@magi/agent-runtime-worker";
import type { Db } from "mongodb";
import { getCopilotSpendCap } from "./users.js";

/** The copilot's own agent id, as defined in config/teams/copilot.yaml. */
export const COPILOT_AGENT_ID = "copilot";

/**
 * Lifetime spend for the copilot, read fresh from missionStats every call —
 * same "no cache for verification-critical data" discipline as the mission
 * spend cap (see agent-stats.ts's module header). Cheap to construct a
 * StatsCollector per call: it does no I/O beyond the read itself.
 */
export async function readCopilotSpend(
	db: Db,
	missionId: string,
): Promise<number> {
	const stats = await new StatsCollector(
		createMongoAgentStatsRepository(db),
	).readLifetime(missionId, COPILOT_AGENT_ID);
	return stats?.lifetimeCostUsd ?? 0;
}

/**
 * Returns an error message if the user's copilot spend cap is reached (the
 * caller should refuse the turn with it), or null if it may proceed.
 */
export async function checkCopilotSpendCap(
	db: Db,
	userId: string,
): Promise<string | null> {
	const capUsd = await getCopilotSpendCap(db, userId);
	if (capUsd === undefined) return null;
	const spentUsd = await readCopilotSpend(db, `copilot-${userId}`);
	if (spentUsd < capUsd) return null;
	return `Copilot spend cap reached ($${spentUsd.toFixed(2)} / $${capUsd.toFixed(2)}). Raise the cap in Limits to continue.`;
}
