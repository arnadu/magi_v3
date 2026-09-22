import { describe, expect, it } from "vitest";
import { pctColor } from "../src/LimitsPanel";
import { fmtHours, fmtShape } from "../src/UpgradeLimitsSection";

describe("fmtHours", () => {
	it.each([
		[0, "0.0"],
		[0.5, "0.5"],
		[9.94, "9.9"],
		[9.96, "10.0"],
		[10, "10"],
		[10.4, "10"],
		[23.9, "24"],
		[24, "24"],
	])("%s -> %s", (hours, expected) => {
		expect(fmtHours(hours)).toBe(expected);
	});
});

describe("fmtShape", () => {
	it("formats singular CPU count without a trailing s", () => {
		expect(fmtShape({ cpuKind: "shared", cpus: 1, memoryMb: 1024 })).toBe(
			"shared, 1 CPU, 1 GB",
		);
	});

	it("formats plural CPU counts", () => {
		expect(fmtShape({ cpuKind: "performance", cpus: 2, memoryMb: 8192 })).toBe(
			"performance, 2 CPUs, 8 GB",
		);
	});

	it("shows a fractional GB figure for non-integer sizes", () => {
		expect(fmtShape({ cpuKind: "shared", cpus: 1, memoryMb: 1536 })).toBe(
			"shared, 1 CPU, 1.5 GB",
		);
	});
});

describe("pctColor (reused from LimitsPanel for the runtime bar)", () => {
	it("colors the hours bar with the same 70/90 thresholds as the $ bar", () => {
		expect(pctColor(0, 24).color).toBe("var(--ok)");
		expect(pctColor(16, 24).color).toBe("var(--ok)"); // 67%
		expect(pctColor(18, 24).color).toBe("var(--warn)"); // 75%
		expect(pctColor(22, 24).color).toBe("var(--bad)"); // 91.6%
	});

	it("caps the percentage at 100 even if usedHours exceeds capHours transiently", () => {
		expect(pctColor(30, 24).pct).toBe(100);
	});

	it("is 0% for a fresh mission with no cap configured (defensive: cap=0)", () => {
		expect(pctColor(0, 0)).toEqual({ pct: 0, color: "var(--ok)" });
	});
});
