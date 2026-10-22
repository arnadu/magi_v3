import { DEFAULT_MISSION_MAX_COST_USD } from "@magi/agent-config";
import { describe, expect, it } from "vitest";
import { resolveCliSpendCap, stopWhenCapReached } from "../src/cli-cap.js";

describe("resolveCliSpendCap", () => {
	it("prefers the mission's cap, then MAX_COST_USD, else the default — never none (SCH-4)", () => {
		expect(resolveCliSpendCap(12, { MAX_COST_USD: "5" })).toBe(12);
		expect(resolveCliSpendCap(undefined, { MAX_COST_USD: "5" })).toBe(5);
		expect(resolveCliSpendCap(undefined, {})).toBe(
			DEFAULT_MISSION_MAX_COST_USD,
		);
	});
	it("refuses a malformed MAX_COST_USD instead of running uncapped", () => {
		expect(() => resolveCliSpendCap(undefined, { MAX_COST_USD: "-3" })).toThrow(
			/positive number/,
		);
	});
});

describe("stopWhenCapReached", () => {
	const stats = (lifetime: number, turn = 0) => ({
		readMissionSnapshot: async () => [
			{ agentId: "a", lifetimeCostUsd: lifetime, turnCostUsd: turn },
		],
	});
	it("aborts the run once lifetime plus in-flight turn cost reaches the cap", async () => {
		const ac = new AbortController();
		expect(await stopWhenCapReached(stats(4, 1.5) as never, "m", 5, ac)).toBe(
			5.5,
		);
		expect(ac.signal.aborted).toBe(true);
	});
	it("leaves a run under the cap alone and survives a failed read", async () => {
		const ac = new AbortController();
		expect(await stopWhenCapReached(stats(1) as never, "m", 5, ac)).toBeNull();
		const failing = {
			readMissionSnapshot: async () => {
				throw new Error("mongo down");
			},
		};
		expect(await stopWhenCapReached(failing as never, "m", 5, ac)).toBeNull();
		expect(ac.signal.aborted).toBe(false);
	});
});
