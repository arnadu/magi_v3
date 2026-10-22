/**
 * capForConfigWrite — the rule every config write applies (SCH-4, ADR-0034):
 * a mission never loses its cap, and no write raises it above the ceiling.
 */
import { describe, expect, it } from "vitest";
import {
	capForConfigWrite,
	DEFAULT_MISSION_MAX_COST_USD,
	SpendCapCeilingExceededError,
} from "../src/spend.js";

describe("capForConfigWrite", () => {
	it("keeps an explicit cap", () => {
		expect(capForConfigWrite(40, { capUsd: 10, ceilingUsd: 100 })).toBe(40);
	});

	it("keeps the stored cap when the snapshot names none — a save never removes a cap", () => {
		expect(capForConfigWrite(undefined, { capUsd: 12 })).toBe(12);
	});

	it("gives a mission that never had a cap the default, clamped to a lower ceiling", () => {
		expect(capForConfigWrite(undefined, {})).toBe(DEFAULT_MISSION_MAX_COST_USD);
		expect(capForConfigWrite(undefined, { ceilingUsd: 10 })).toBe(10);
	});

	it("refuses raising the cap above the ceiling", () => {
		expect(() =>
			capForConfigWrite(150, { capUsd: 20, ceilingUsd: 100 }),
		).toThrow(SpendCapCeilingExceededError);
	});

	it("does not re-check a cap the write leaves unchanged", () => {
		expect(capForConfigWrite(50, { capUsd: 50, ceilingUsd: 10 })).toBe(50);
	});
});
