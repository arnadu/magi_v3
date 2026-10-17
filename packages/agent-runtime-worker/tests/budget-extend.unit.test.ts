import { describe, expect, it } from "vitest";
import { capAfterExtend } from "../src/monitor-routes/budget.js";

describe("capAfterExtend (BD1)", () => {
	it("adds to an existing cap", () => {
		expect(capAfterExtend(20, 7.5, 5)).toBe(25);
	});
	it("starts from the spend so far when the mission has no cap — never below what was already spent", () => {
		expect(capAfterExtend(undefined, 12.3, 5)).toBeCloseTo(17.3);
		expect(capAfterExtend(undefined, 0, 5)).toBe(5);
	});
});
