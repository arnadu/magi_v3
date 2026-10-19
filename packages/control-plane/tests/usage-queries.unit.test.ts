/**
 * Lifetime usage comes from the stats collections. The call log is pruned
 * after a day, so summing it undercounted the copilot spend cap and the
 * per-mission usage figures; these tests pin the replacement sources.
 */
import { describe, expect, it } from "vitest";
import { lifetimeCostByMission, lifetimeUsage } from "../src/usage-queries.js";
import { fakeDb } from "./support/fake-db.js";

const turn = (missionId: string, costUsd: number, calls: number) => ({
	missionId,
	agentId: "copilot",
	turnNumber: 1,
	llmCallCount: calls,
	inputTokens: 100 * calls,
	outputTokens: 10 * calls,
	cacheReadTokens: 5 * calls,
	costUsd,
});

describe("lifetimeUsage", () => {
	it("sums every turn of the mission, with an empty call log", async () => {
		const { db } = fakeDb({
			agentTurnStats: [
				turn("copilot-u1", 1.5, 3),
				turn("copilot-u1", 2.5, 2),
				turn("other", 99, 9),
			],
			llmCallLog: [],
		});
		expect(await lifetimeUsage(db, "copilot-u1")).toEqual({
			calls: 5,
			inputTokens: 500,
			outputTokens: 50,
			cacheReadTokens: 25,
			costUsd: 4,
		});
	});

	it("is all zeros for a mission with no turns", async () => {
		const { db } = fakeDb({ agentTurnStats: [] });
		expect(await lifetimeUsage(db, "none")).toEqual({
			calls: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			costUsd: 0,
		});
	});
});

describe("lifetimeCostByMission", () => {
	it("adds up every agent of each mission and ignores others", async () => {
		const { db } = fakeDb({
			missionStats: [
				{
					missionId: "m1",
					agentId: "a",
					lifetimeCostUsd: 3,
					lifetimeLlmCallCount: 10,
				},
				{
					missionId: "m1",
					agentId: "b",
					lifetimeCostUsd: 2,
					lifetimeLlmCallCount: 5,
				},
				{
					missionId: "m2",
					agentId: "a",
					lifetimeCostUsd: 7,
					lifetimeLlmCallCount: 1,
				},
				{
					missionId: "m3",
					agentId: "a",
					lifetimeCostUsd: 50,
					lifetimeLlmCallCount: 50,
				},
			],
		});
		const out = await lifetimeCostByMission(db, ["m1", "m2", "m4"]);
		expect(out.get("m1")).toEqual({ totalCostUsd: 5, calls: 15 });
		expect(out.get("m2")).toEqual({ totalCostUsd: 7, calls: 1 });
		expect(out.has("m3")).toBe(false);
		expect(out.has("m4")).toBe(false);
	});
});
