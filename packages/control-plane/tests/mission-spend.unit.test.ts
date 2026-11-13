import { describe, expect, it } from "vitest";
import { missionSpend } from "../src/mission-spend.js";

describe("missionSpend", () => {
	it("totals every agent's spend and subtracts what the cost events attributed", () => {
		// The Houseplant case: an image-heavy turn with no task update carried over.
		const s = missionSpend(
			new Map([
				["creative-director", 5.449],
				["experience-designer", 0.102],
			]),
			[
				{ alloc: { "TASK-1": 0.1, "TASK-2": 0.159 } },
				{ alloc: { "TASK-1": 0.102 } },
			],
			25,
		);
		expect(s.totalUsd).toBeCloseTo(5.551);
		expect(s.attributedUsd).toBeCloseTo(0.361);
		expect(s.unattributedUsd).toBeCloseTo(5.19);
		expect(s.capUsd).toBe(25);
	});

	it("never reports a negative remainder", () => {
		const s = missionSpend(
			new Map([["a", 1]]),
			[{ alloc: { x: 1.000001 } }],
			null,
		);
		expect(s.unattributedUsd).toBe(0);
		expect(s.capUsd).toBeNull();
	});
});
