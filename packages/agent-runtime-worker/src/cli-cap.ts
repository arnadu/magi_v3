/**
 * Spend cap for a local CLI run — the same rule the daemon applies: the
 * mission's own `maxCostUsd`, else `MAX_COST_USD`, else the platform default.
 * Nothing runs without a cap (SCH-4).
 */

import { DEFAULT_MISSION_MAX_COST_USD } from "@magi/agent-config";
import type { StatsCollector } from "./agent-stats.js";
import { missionLifetimeCostUsd } from "./limits.js";

export function resolveCliSpendCap(
	missionCap: number | undefined,
	env: NodeJS.ProcessEnv = process.env,
): number {
	if (missionCap !== undefined) return missionCap;
	if (!env.MAX_COST_USD) return DEFAULT_MISSION_MAX_COST_USD;
	const v = Number.parseFloat(env.MAX_COST_USD);
	if (!Number.isFinite(v) || v <= 0) {
		throw new Error(
			`MAX_COST_USD must be a positive number, got: ${env.MAX_COST_USD}`,
		);
	}
	return v;
}

/**
 * Checked after every model reply, like the daemon's per-call check.
 * Reaching the cap ends the run instead of pausing it — a CLI session has no
 * operator route to raise the cap. Returns the mission total when it stopped
 * the run, null otherwise.
 */
export async function stopWhenCapReached(
	statsCollector: Pick<StatsCollector, "readMissionSnapshot">,
	missionId: string,
	maxCostUsd: number,
	ac: AbortController,
): Promise<number | null> {
	let total: number;
	try {
		total = missionLifetimeCostUsd(
			await statsCollector.readMissionSnapshot(missionId),
		);
	} catch (e) {
		console.error(`[cli] cap check failed: ${(e as Error).message}`);
		return null;
	}
	if (total < maxCostUsd || ac.signal.aborted) return null;
	console.error(
		`\nSpend cap reached: $${total.toFixed(2)} of $${maxCostUsd.toFixed(2)} — stopping the mission.`,
	);
	ac.abort();
	return total;
}
