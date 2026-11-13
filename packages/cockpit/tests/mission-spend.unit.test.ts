import { describe, expect, it } from "vitest";
import { headerSpend, unattributedUsd } from "../src/mission-spend";
import type { FoldedTree } from "../src/types";

const objective = (costUsd: number, budgetUsd = 0) =>
	({ costUsd, budgetUsd }) as FoldedTree["objectives"][number];
const tree = (spend?: FoldedTree["spend"]): FoldedTree => ({
	objectives: [objective(0.2), objective(0.06)],
	tasks: [],
	orphanTasks: [],
	overheadCostUsd: 0,
	...(spend ? { spend } : {}),
});

describe("mission spend in the cockpit", () => {
	it("shows the mission's real spend against its cap, not the objectives' sum over their budgets", () => {
		const t = tree({
			totalUsd: 5.7,
			attributedUsd: 0.26,
			unattributedUsd: 5.44,
			capUsd: 25,
		});
		expect(headerSpend(t)).toEqual({ spentUsd: 5.7, capUsd: 25 });
		expect(unattributedUsd(t)).toBe(5.44);
	});

	it("falls back to the objectives' sum without a cap when the server sends no spend", () => {
		const t = tree();
		expect(headerSpend(t).spentUsd).toBeCloseTo(0.26);
		expect(headerSpend(t).capUsd).toBeNull();
		expect(unattributedUsd(t)).toBeNull();
	});

	it("hides a sub-cent unattributed remainder", () => {
		expect(
			unattributedUsd(
				tree({
					totalUsd: 1,
					attributedUsd: 0.998,
					unattributedUsd: 0.002,
					capUsd: null,
				}),
			),
		).toBeNull();
	});
});
