import { describe, expect, it } from "vitest";
import type { TurnCost } from "../src/data";
import {
	cumulativeCostLines,
	fullTimeDomain,
	seqColor,
} from "../src/trace/trace-geometry";

const turn = (
	agentId: string,
	start: string,
	end: string,
	costUsd: number,
): TurnCost =>
	({
		agentId,
		turnNumber: 1,
		startedAt: start,
		completedAt: end,
		costUsd,
		llmCallCount: 1,
		status: "complete",
	}) as TurnCost;

describe("seqColor", () => {
	it("snaps to the ramp's ends and switches label colour on dark steps", () => {
		expect(seqColor(0)).toEqual({ bg: "var(--seq-100)", fg: "var(--txt)" });
		expect(seqColor(1)).toEqual({ bg: "var(--seq-700)", fg: "#fff" });
	});
});

describe("fullTimeDomain", () => {
	it("spans turns and messages and is never zero-width", () => {
		const t = "2026-10-19T10:00:00.000Z";
		const [min, max] = fullTimeDomain([turn("a", t, t, 1)], []);
		expect(max - min).toBe(1);
		const [lo, hi] = fullTimeDomain(
			[turn("a", "2026-10-19T10:00:00Z", "2026-10-19T11:00:00Z", 1)],
			[{ timestamp: "2026-10-19T12:00:00Z" } as never],
		);
		expect(hi - lo).toBe(2 * 3600_000);
	});
});

describe("cumulativeCostLines", () => {
	it("builds step-after lines per agent, boxes at the pre-jump level, and the max total", () => {
		const series = [
			turn("b", "2026-10-19T10:30:00Z", "2026-10-19T10:40:00Z", 2),
			turn("a", "2026-10-19T10:00:00Z", "2026-10-19T10:10:00Z", 1),
			turn("a", "2026-10-19T11:00:00Z", "2026-10-19T11:10:00Z", 0.5),
		];
		const domain: [number, number] = [0, 10];
		const { perAgentLine, boxes, maxCum } = cumulativeCostLines(
			["a", "b", "idle"],
			series,
			domain,
			(t) => t,
		);
		const a = perAgentLine.get("a") ?? [];
		expect(a.map((p) => p.cum)).toEqual([0, 0, 1, 1, 1.5, 1.5]);
		expect(a[0].t).toBe(0);
		expect(a.at(-1)?.t).toBe(10);
		expect(perAgentLine.has("idle")).toBe(false);
		expect(boxes.map((b) => b.cumBefore)).toEqual([0, 1, 0]);
		expect(maxCum).toBe(2);
	});

	it("never returns a zero maximum (the y scale divides by it)", () => {
		expect(
			cumulativeCostLines([], [], [0, 1], (t) => t).maxCum,
		).toBeGreaterThan(0);
	});
});
