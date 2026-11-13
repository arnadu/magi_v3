/**
 * The mission's spend as the objectives view reports it: the real total
 * (every agent's lifetime cost plus its in-flight turn, the same figure the
 * Limits panel and the spend cap use), how much of it the objectives store
 * has attributed, and the rest. Attribution happens at turn end and can
 * carry over (objectives/attribution.ts): a turn in which the agent updated
 * no task is attributed later, so summing objective costs alone under-reports
 * the mission — by $5 after one image-heavy turn.
 */

export interface MissionSpend {
	totalUsd: number;
	attributedUsd: number;
	/** Spent but not yet attributed to a task, an objective or overhead. */
	unattributedUsd: number;
	capUsd: number | null;
}

export function missionSpend(
	costByAgent: ReadonlyMap<string, number>,
	costEvents: ReadonlyArray<{ alloc: Record<string, number> }>,
	capUsd: number | null,
): MissionSpend {
	let totalUsd = 0;
	for (const usd of costByAgent.values()) totalUsd += usd;
	let attributedUsd = 0;
	for (const ev of costEvents) {
		for (const usd of Object.values(ev.alloc)) attributedUsd += usd;
	}
	return {
		totalUsd,
		attributedUsd,
		unattributedUsd: Math.max(0, totalUsd - attributedUsd),
		capUsd,
	};
}
