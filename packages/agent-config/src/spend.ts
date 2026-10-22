/**
 * The spend-cap invariants every writer of a mission's config shares
 * (ADR-0034): a mission always has a cap, and no config write sets it above
 * the mission's ceiling. They live here, beside the schema, so the control
 * plane, the mission copilot and the config writer cannot drift apart.
 */

/** Cap applied when a mission's config sets none. */
export const DEFAULT_MISSION_MAX_COST_USD = 25;

export class SpendCapCeilingExceededError extends Error {
	constructor(
		public readonly requestedUsd: number,
		public readonly ceilingUsd: number,
	) {
		super(
			`Requested cap $${requestedUsd.toFixed(2)} exceeds this mission's spend-cap ceiling of $${ceilingUsd.toFixed(2)} — raise the ceiling first via the cockpit Limits panel (an operator-only action no mission tool can perform).`,
		);
		this.name = "SpendCapCeilingExceededError";
	}
}

/**
 * The cap a config write stores. A snapshot that names none keeps the
 * mission's stored cap — a config save never removes a cap — or, for a
 * mission that never had one, gets the default (clamped to a lower ceiling).
 * Raising the cap above the mission's ceiling is refused; a cap the write
 * leaves unchanged is not re-checked, so an unrelated edit is never blocked.
 */
export function capForConfigWrite(
	requestedUsd: number | undefined,
	stored: { capUsd?: number; ceilingUsd?: number },
): number {
	const { capUsd, ceilingUsd } = stored;
	if (requestedUsd === undefined) {
		if (capUsd !== undefined) return capUsd;
		return ceilingUsd === undefined
			? DEFAULT_MISSION_MAX_COST_USD
			: Math.min(DEFAULT_MISSION_MAX_COST_USD, ceilingUsd);
	}
	if (
		requestedUsd !== capUsd &&
		ceilingUsd !== undefined &&
		requestedUsd > ceilingUsd
	) {
		throw new SpendCapCeilingExceededError(requestedUsd, ceilingUsd);
	}
	return requestedUsd;
}
