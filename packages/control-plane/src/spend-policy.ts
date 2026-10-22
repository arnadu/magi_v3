/**
 * Spend containment defaults (ADR-0034, decision D-3): every mission is
 * created with a spend cap, and no cap — the operator's included — can be
 * raised above a platform ceiling that only an admin may lift. Before this,
 * `maxCostUsd` was opt-in, no shipped template set one, and the tenant could
 * edit both the cap and its ceiling (audit LM1/LIM1/CFG2/TPL5).
 */

import {
	DEFAULT_MISSION_MAX_COST_USD,
	storedCollection,
	type TeamConfig,
} from "@magi/agent-config";
import type { Db } from "mongodb";

export { DEFAULT_MISSION_MAX_COST_USD };
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

/**
 * Give a mission that has no cap the default, before a machine for it starts
 * (machine-lifecycle.ts calls this on every provision and resume), so nothing
 * runs uncapped (SCH-4). A failed write throws: better not to start the
 * machine than to start it without a cap.
 */
export async function ensureMissionSpendCap(
	db: Db,
	missionId: string,
): Promise<void> {
	await storedCollection(db, "missions").updateOne(
		// null matches a missing field as well as an explicit null.
		{ missionId, "mission.maxCostUsd": null },
		{ $set: { "mission.maxCostUsd": DEFAULT_MISSION_MAX_COST_USD } },
	);
}

/**
 * Start-up pass: every mission that is not destroyed and has no cap gets the
 * default. Before SCH-4 was fixed, a draft launched by the copilot or re-saved
 * without a cap could carry none.
 */
export async function backfillMissionCaps(db: Db): Promise<number> {
	const r = await storedCollection(db, "missions").updateMany(
		{ status: { $ne: "destroyed" }, "mission.maxCostUsd": null },
		{ $set: { "mission.maxCostUsd": DEFAULT_MISSION_MAX_COST_USD } },
	);
	if (r.modifiedCount > 0) {
		console.log(
			`[control-plane] spend caps: set the default $${DEFAULT_MISSION_MAX_COST_USD} on ${r.modifiedCount} mission(s) that had none`,
		);
	}
	return r.modifiedCount;
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
		return `A ceiling of $${requestedUsd.toFixed(2)} is above the platform ceiling of $${platform.toFixed(2)}, the most any mission may spend unless a platform admin allows more. Set a ceiling of $${platform.toFixed(2)} or less, or ask a platform admin (a user listed in PLATFORM_ADMIN_USER_IDS) to set it. The platform owner can also raise PLATFORM_MAX_COST_CEILING_USD. See docs/spend-limits.md.`;
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
/** Firebase UIDs listed in PLATFORM_ADMIN_USER_IDS: platform operators signed in through the cockpit. */
export function platformAdminUserIds(
	env: NodeJS.ProcessEnv = process.env,
): Set<string> {
	return new Set(
		(env.PLATFORM_ADMIN_USER_IDS ?? "")
			.split(",")
			.map((id) => id.trim())
			.filter((id) => id.length > 0),
	);
}

/**
 * May this request set a mission's ceiling above the platform ceiling? The
 * admin key, or a signed-in user listed in PLATFORM_ADMIN_USER_IDS — the
 * platform operator should not need the raw admin key to unblock a mission.
 */
export function mayExceedPlatformCeiling(
	req: { isAdmin?: boolean; userId?: string },
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return (
		Boolean(req.isAdmin) ||
		(req.userId !== undefined && platformAdminUserIds(env).has(req.userId))
	);
}

/**
 * Start-up pass over the ceiling field (ADR-0034):
 * - a mission with no ceiling gets the platform ceiling, or its own existing
 *   cap if that is higher — a ceiling below the cap would refuse every cap
 *   change on a mission that was legitimately running above $100;
 * - a mission still carrying exactly that mistake (ceiling equal to the
 *   platform default, cap above it — what the first back-fill of 2026-10-17
 *   wrote) is repaired the same way.
 * A cap above its ceiling is never a valid state (every cap writer checks
 * the ceiling), so raising the ceiling to the cap only restores consistency.
 */
export async function backfillMissionCeilings(
	db: Db,
	env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	const platform = platformMaxCostCeilingUsd(env);
	const col = storedCollection(db, "missions");
	const candidates = await col
		.find({
			$or: [
				{ maxCostCeilingUsd: { $exists: false } },
				{
					maxCostCeilingUsd: platform,
					"mission.maxCostUsd": { $gt: platform },
				},
			],
		})
		.toArray();
	let changed = 0;
	for (const m of candidates) {
		const cap = m.mission?.maxCostUsd;
		const ceiling = typeof cap === "number" && cap > platform ? cap : platform;
		if (m.maxCostCeilingUsd === ceiling) continue;
		await col.updateOne(
			{ missionId: m.missionId },
			{ $set: { maxCostCeilingUsd: ceiling } },
		);
		changed++;
	}
	if (changed > 0) {
		console.log(
			`[control-plane] spend-cap ceilings: set or repaired on ${changed} mission(s) (platform ceiling $${platform}; never below a mission's existing cap)`,
		);
	}
	return changed;
}
