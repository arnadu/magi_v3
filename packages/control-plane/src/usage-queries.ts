/**
 * Lifetime usage figures. They come from the stats collections, never from
 * `llmCallLog`: the call log is deleted after its 90-day retention window
 * (scheduler.ts), so a sum over it is not a lifetime figure.
 */

import { type AgentTurnStats, ref, storedCollection } from "@magi/agent-config";
import type { Db } from "mongodb";

export interface UsageTotals {
	calls: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	costUsd: number;
}

const turn = ref<AgentTurnStats>();

/** Token and cost totals over every turn of every agent in the mission (the running turn included). */
export async function lifetimeUsage(
	db: Db,
	missionId: string,
): Promise<UsageTotals> {
	const [row] = await storedCollection(db, "agentTurnStats")
		.aggregate<UsageTotals>([
			{ $match: { missionId } },
			{
				$group: {
					_id: null,
					calls: { $sum: turn("llmCallCount") },
					inputTokens: { $sum: turn("inputTokens") },
					outputTokens: { $sum: turn("outputTokens") },
					cacheReadTokens: { $sum: turn("cacheReadTokens") },
					costUsd: { $sum: turn("costUsd") },
				},
			},
		])
		.toArray();
	return {
		calls: row?.calls ?? 0,
		inputTokens: row?.inputTokens ?? 0,
		outputTokens: row?.outputTokens ?? 0,
		cacheReadTokens: row?.cacheReadTokens ?? 0,
		costUsd: row?.costUsd ?? 0,
	};
}

/** Lifetime cost and LLM-call count per mission, from completed turns (`missionStats`). */
export async function lifetimeCostByMission(
	db: Db,
	missionIds: string[],
): Promise<Map<string, { totalCostUsd: number; calls: number }>> {
	const out = new Map<string, { totalCostUsd: number; calls: number }>();
	const rows = await storedCollection(db, "missionStats")
		.find({ missionId: { $in: missionIds } })
		.toArray();
	for (const r of rows) {
		const m = out.get(r.missionId) ?? { totalCostUsd: 0, calls: 0 };
		m.totalCostUsd += r.lifetimeCostUsd;
		m.calls += r.lifetimeLlmCallCount;
		out.set(r.missionId, m);
	}
	return out;
}
