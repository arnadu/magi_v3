/**
 * Pure per-mission resource-alert ratio calculators (ADR-0032 Decision 2/4).
 * No I/O, no fakes needed — resource-monitor.unit.test.ts covers the
 * orchestration that feeds these.
 */

import { describe, expect, it } from "vitest";
import {
	spendCapRatio,
	spendSpikeRatio,
	upgradeCapNearRatio,
	upgradeIdleRatio,
} from "../src/resource-alerts.js";

describe("spendCapRatio", () => {
	it("returns null when no cap is configured", () => {
		expect(spendCapRatio(100, undefined)).toBeNull();
	});

	it("returns null for a non-positive cap", () => {
		expect(spendCapRatio(100, 0)).toBeNull();
		expect(spendCapRatio(100, -5)).toBeNull();
	});

	it("divides spend by the cap", () => {
		expect(spendCapRatio(90, 100)).toBe(0.9);
		expect(spendCapRatio(98, 100)).toBe(0.98);
	});
});

describe("spendSpikeRatio", () => {
	it("is 0 below the $5 minimum, regardless of baseline", () => {
		expect(spendSpikeRatio(4.99, 0.1)).toBe(0);
	});

	it("is 0 with no baseline yet (a new mission's first days)", () => {
		expect(spendSpikeRatio(50, 0)).toBe(0);
	});

	it("is exactly 1.0 at 3x the trailing daily average", () => {
		expect(spendSpikeRatio(30, 10)).toBe(1);
	});

	it("is below 1.0 under 3x, above 1.0 over 3x", () => {
		expect(spendSpikeRatio(20, 10)).toBeLessThan(1);
		expect(spendSpikeRatio(40, 10)).toBeGreaterThan(1);
	});
});

describe("upgradeCapNearRatio", () => {
	it("is 0 for a non-positive cap", () => {
		expect(upgradeCapNearRatio(1000, 0)).toBe(0);
	});

	it("divides upgraded ms by the cap ms", () => {
		expect(upgradeCapNearRatio(18 * 3_600_000, 24 * 3_600_000)).toBeCloseTo(
			0.75,
		);
	});
});

describe("upgradeIdleRatio", () => {
	const now = new Date("2026-09-22T12:00:00.000Z");
	const base = {
		isUpgraded: true,
		runningJobs: 0,
		lastActivityAt: new Date("2026-09-22T11:00:00.000Z"), // 60 min ago
		now,
		idleMinutesThreshold: 30,
	};

	it("is 0 when not upgraded", () => {
		expect(upgradeIdleRatio({ ...base, isUpgraded: false })).toBe(0);
	});

	it("is 0 when a job is running", () => {
		expect(upgradeIdleRatio({ ...base, runningJobs: 1 })).toBe(0);
	});

	it("is 0 when the runningJobs sample is missing (never guesses idle)", () => {
		expect(upgradeIdleRatio({ ...base, runningJobs: null })).toBe(0);
	});

	it("is 0 when there is no activity timestamp to measure from", () => {
		expect(upgradeIdleRatio({ ...base, lastActivityAt: null })).toBe(0);
	});

	it("is idleMinutes / threshold when upgraded, idle, and jobless", () => {
		// 60 min idle / 30 min threshold = 2.0
		expect(upgradeIdleRatio(base)).toBeCloseTo(2);
	});

	it("is below 1.0 just short of the threshold", () => {
		expect(
			upgradeIdleRatio({
				...base,
				lastActivityAt: new Date(now.getTime() - 29 * 60_000),
			}),
		).toBeLessThan(1);
	});
});
