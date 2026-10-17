/**
 * Spend containment defaults (ADR-0034, decision D-3): every mission is
 * created with a spend cap, and no cap — the operator's included — can be
 * raised above a platform ceiling that only an admin may lift. Before this,
 * `maxCostUsd` was opt-in, no shipped template set one, and the tenant could
 * edit both the cap and its ceiling (audit LM1/LIM1/CFG2/TPL5).
 */

import type { TeamConfig } from "@magi/agent-config";
import type { Db } from "mongodb";

/** Cap applied at creation when the config sets none. */
export const DEFAULT_MISSION_MAX_COST_USD = 25;
/** Platform ceiling when PLATFORM_MAX_COST_CEILING_USD is unset. */
export const DEFAULT_PLATFORM_MAX_COST_CEILING_USD = 100;

/** `PLATFORM_MAX_COST_CEILING_USD`: the highest cap any non-admin mission may carry. */
export function platformMaxCostCeilingUsd(
	env: NodeJS.ProcessEnv = process.env,
): number {
	const raw = env.PLATFORM_MAX_COST_CEILING_USD;
	const n = raw === undefined ? Number.NaN : Number(raw);
	return Number.isFinite(n) && n > 0
		? n
		: DEFAULT_PLATFORM_MAX_COST_CEILING_USD;
}

/** A mission block with a cap; an explicit cap is kept, an absent one becomes the default. */
export function withDefaultSpendCap<T extends { maxCostUsd?: number }>(
	mission: T,
): T & { maxCostUsd: number } {
	return {
		...mission,
		maxCostUsd: mission.maxCostUsd ?? DEFAULT_MISSION_MAX_COST_USD,
	};
}

/** The ceiling that binds a mission: its own, or the platform's when it has none. */
export function effectiveCeilingUsd(
	mission: { maxCostCeilingUsd?: number },
	env: NodeJS.ProcessEnv = process.env,
): number {
	return mission.maxCostCeilingUsd ?? platformMaxCostCeilingUsd(env);
}

/** Why a requested ceiling is not allowed for this caller, or null. */
export function ceilingChangeRefusal(
	requestedUsd: number,
	isAdmin: boolean,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	const platform = platformMaxCostCeilingUsd(env);
	if (!isAdmin && requestedUsd > platform) {
		return `A ceiling of $${requestedUsd.toFixed(2)} exceeds the platform ceiling of $${platform.toFixed(2)}; only a platform admin can set one above it.`;
	}
	return null;
}

export type MissionBlock = TeamConfig["mission"];

/**
 * Missions created before every document carried a ceiling get the platform
 * ceiling once, at startup, so the daemon-side cap writers (which only know
 * the document's own ceiling) bound them too. Idempotent: documents that
 * already have a ceiling are untouched.
 */
export async function backfillMissionCeilings(
	db: Db,
	env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	const r = await db
		.collection("missions")
		.updateMany(
			{ maxCostCeilingUsd: { $exists: false } },
			{ $set: { maxCostCeilingUsd: platformMaxCostCeilingUsd(env) } },
		);
	if (r.modifiedCount > 0) {
		console.log(
			`[control-plane] applied the platform spend-cap ceiling to ${r.modifiedCount} mission(s) that had none`,
		);
	}
	return r.modifiedCount;
}
