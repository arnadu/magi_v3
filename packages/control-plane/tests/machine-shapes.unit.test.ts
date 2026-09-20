/**
 * Machine shape rules, price estimate and menu (ADR-0031). Pure functions,
 * no I/O.
 */

import { describe, expect, it } from "vitest";
import {
	allowedMemoryRange,
	buildMenu,
	DEFAULT_MACHINE,
	describeAllowedShapes,
	estimateCostPerHourUsd,
	type MachineShape,
	sameShape,
	validateUpgradeRequest,
} from "../src/machine-shapes.js";

function ok(body: unknown) {
	const r = validateUpgradeRequest(body);
	if (!r.ok) throw new Error(`expected valid, got: ${r.error}`);
	return r.request;
}

function errorOf(body: unknown): string {
	const r = validateUpgradeRequest(body);
	if (r.ok) throw new Error("expected invalid");
	return r.error;
}

const base = {
	cpuKind: "shared",
	cpus: 1,
	memoryMb: 2048,
	durationMinutes: 30,
};

describe("validateUpgradeRequest — accepted", () => {
	it("returns the typed request", () => {
		expect(ok(base)).toEqual(base);
	});

	it.each([
		["shared", 1, 256],
		["shared", 1, 2048],
		["shared", 2, 512],
		["shared", 2, 4096],
		["shared", 4, 1024],
		["shared", 4, 8192],
		["performance", 1, 2048],
		["performance", 1, 8192],
		["performance", 2, 4096],
		["performance", 2, 16384],
		["performance", 4, 8192],
		["performance", 4, 16384],
	])("%s, %s CPU(s), %s MB is allowed", (cpuKind, cpus, memoryMb) => {
		expect(ok({ cpuKind, cpus, memoryMb, durationMinutes: 10 })).toBeDefined();
	});

	it.each([1, 30, 60])("duration %s minutes is allowed", (durationMinutes) => {
		expect(ok({ ...base, durationMinutes }).durationMinutes).toBe(
			durationMinutes,
		);
	});
});

describe("validateUpgradeRequest — rejected", () => {
	it.each([
		[
			"shared 1 CPU above 2 GB",
			{ ...base, memoryMb: 2304 },
			/outside 256–2048/,
		],
		["shared 1 CPU below 256 MB", { ...base, memoryMb: 0 }, /outside|multiple/],
		[
			"performance 1 CPU below 2 GB",
			{ ...base, cpuKind: "performance", memoryMb: 1792 },
			/outside 2048–8192/,
		],
		[
			"performance 1 CPU above 8 GB",
			{ ...base, cpuKind: "performance", memoryMb: 8448 },
			/outside 2048–8192/,
		],
		[
			"performance 4 CPUs above the 16 GB maximum",
			{ ...base, cpuKind: "performance", cpus: 4, memoryMb: 16640 },
			/outside 8192–16384/,
		],
		[
			"performance 4 CPUs below its minimum",
			{ ...base, cpuKind: "performance", cpus: 4, memoryMb: 4096 },
			/outside 8192–16384/,
		],
		[
			"more CPUs than the maximum",
			{ ...base, cpus: 6 },
			/exceeds the maximum of 4/,
		],
		[
			"a CPU count Fly does not offer",
			{ ...base, cpus: 3 },
			/3 CPUs is not offered for shared/,
		],
		[
			"a fractional CPU count",
			{ ...base, cpus: 1.5 },
			/cpus must be a positive integer/,
		],
		[
			"a string CPU count",
			{ ...base, cpus: "2" },
			/cpus must be a positive integer/,
		],
		["zero CPUs", { ...base, cpus: 0 }, /cpus must be a positive integer/],
		[
			"an unknown cpuKind",
			{ ...base, cpuKind: "dedicated" },
			/cpuKind must be/,
		],
		["a missing cpuKind", { ...base, cpuKind: undefined }, /cpuKind must be/],
		[
			"memory not a multiple of 256",
			{ ...base, memoryMb: 1000 },
			/multiple of 256/,
		],
		[
			"fractional memory",
			{ ...base, memoryMb: 1024.5 },
			/integer number of MB/,
		],
		["string memory", { ...base, memoryMb: "2048" }, /integer number of MB/],
		["NaN memory", { ...base, memoryMb: Number.NaN }, /integer number of MB/],
	])("%s", (_name, body, message) => {
		expect(errorOf(body)).toMatch(message);
	});

	it.each([
		["missing", undefined],
		["zero", 0],
		["negative", -5],
		["over the maximum", 61],
		["fractional", 1.5],
		["NaN", Number.NaN],
		["a string", "30"],
		["null", null],
	])("a %s duration is rejected, saying it is required and has no default", (_n, durationMinutes) => {
		const message = errorOf({ ...base, durationMinutes });
		expect(message).toMatch(
			/durationMinutes is required \(there is no default\)/,
		);
		expect(message).toMatch(/1 to 60/);
	});

	it("reports every problem at once, then the allowed shapes", () => {
		const message = errorOf({ cpuKind: "x", cpus: 9, memoryMb: 100 });
		expect(message).toMatch(/cpuKind must be/);
		expect(message).toMatch(/exceeds the maximum/);
		expect(message).toMatch(/multiple of 256/);
		expect(message).toMatch(/durationMinutes is required/);
		expect(message).toContain(describeAllowedShapes());
	});

	it.each([
		null,
		undefined,
		42,
		"shared",
		[],
	])("a non-object body (%j) is rejected", (body) => {
		expect(errorOf(body)).toMatch(/Invalid upgrade request/);
	});
});

describe("validateUpgradeRequest — exhaustive sweep against an independent oracle", () => {
	// Written from the ADR's rules, not from the implementation's tables.
	function oracle(cpuKind: string, cpus: number, memoryMb: number): boolean {
		const perCpu =
			cpuKind === "shared" ? { min: 256, max: 2048 } : { min: 2048, max: 8192 };
		if (![1, 2, 4].includes(cpus)) return false; // Fly-offered counts within the 4-CPU maximum
		if (memoryMb % 256 !== 0) return false;
		return (
			memoryMb >= perCpu.min * cpus &&
			memoryMb <= Math.min(perCpu.max * cpus, 16384)
		);
	}

	it("accepts exactly the shapes the oracle allows", () => {
		let checked = 0;
		for (const cpuKind of ["shared", "performance"]) {
			for (let cpus = 0; cpus <= 17; cpus++) {
				for (let memoryMb = 0; memoryMb <= 40_000; memoryMb += 128) {
					const result = validateUpgradeRequest({
						cpuKind,
						cpus,
						memoryMb,
						durationMinutes: 10,
					});
					expect(result.ok, `${cpuKind} ${cpus} ${memoryMb}`).toBe(
						oracle(cpuKind, cpus, memoryMb),
					);
					checked++;
				}
			}
		}
		expect(checked).toBeGreaterThan(10_000);
	});
});

describe("allowedMemoryRange / describeAllowedShapes", () => {
	it("applies the maximum size on top of Fly's range", () => {
		expect(allowedMemoryRange("performance", 4)).toEqual({
			minMb: 8192,
			maxMb: 16_384,
		});
		expect(allowedMemoryRange("shared", 4)).toEqual({
			minMb: 1024,
			maxMb: 8192,
		});
	});

	it("is null for CPU counts that are invalid or above the maximum", () => {
		expect(allowedMemoryRange("shared", 3)).toBeNull();
		expect(allowedMemoryRange("shared", 6)).toBeNull();
		expect(allowedMemoryRange("performance", 8)).toBeNull();
	});

	it("lists each allowed family", () => {
		const text = describeAllowedShapes();
		expect(text).toContain("shared: 1 CPU 256–2048 MB");
		expect(text).toContain("4 CPUs 1024–8192 MB");
		expect(text).toContain("performance: 1 CPU 2048–8192 MB");
		expect(text).toContain("4 CPUs 8192–16384 MB");
		expect(text).not.toContain("6 CPUs");
	});
});

describe("estimateCostPerHourUsd (display only)", () => {
	it("matches Fly's published base prices", () => {
		expect(
			estimateCostPerHourUsd({ cpuKind: "shared", cpus: 1, memoryMb: 256 }),
		).toBeCloseTo(0.00000078 * 3600, 6);
		expect(
			estimateCostPerHourUsd({
				cpuKind: "performance",
				cpus: 1,
				memoryMb: 2048,
			}),
		).toBeCloseTo(0.00001242 * 3600, 6);
	});

	it("charges for RAM above the preset's base, roughly $5 per GB per 30 days", () => {
		const oneGb = estimateCostPerHourUsd(DEFAULT_MACHINE);
		const twoGb = estimateCostPerHourUsd({
			...DEFAULT_MACHINE,
			memoryMb: 2048,
		});
		const perGbMonth = (twoGb - oneGb) * 24 * 30;
		expect(perGbMonth).toBeGreaterThan(4.5);
		expect(perGbMonth).toBeLessThan(5.5);
	});

	it("increases with RAM and with CPUs", () => {
		const shapes: MachineShape[] = [
			{ cpuKind: "shared", cpus: 1, memoryMb: 1024 },
			{ cpuKind: "shared", cpus: 1, memoryMb: 2048 },
			{ cpuKind: "shared", cpus: 2, memoryMb: 2048 },
			{ cpuKind: "performance", cpus: 1, memoryMb: 2048 },
			{ cpuKind: "performance", cpus: 1, memoryMb: 4096 },
			{ cpuKind: "performance", cpus: 2, memoryMb: 4096 },
		];
		const costs = shapes.map(estimateCostPerHourUsd);
		expect([...costs].sort((a, b) => a - b)).toEqual(costs);
		expect(new Set(costs).size).toBe(costs.length);
	});
});

describe("buildMenu", () => {
	const menu = buildMenu();

	it("offers only shapes the validator accepts", () => {
		for (const entry of menu) {
			expect(
				validateUpgradeRequest({ ...entry.shape, durationMinutes: 60 }).ok,
				entry.name,
			).toBe(true);
		}
	});

	it("has unique names and positive, priced entries", () => {
		expect(new Set(menu.map((m) => m.name)).size).toBe(menu.length);
		for (const entry of menu) expect(entry.costPerHourUsd).toBeGreaterThan(0);
	});

	it("never includes the default machine, which is not an upgrade", () => {
		expect(menu.some((m) => sameShape(m.shape, DEFAULT_MACHINE))).toBe(false);
	});

	it("gets more expensive from small to large within each family", () => {
		const shared = menu.filter((m) => m.shape.cpuKind === "shared");
		const perf = menu.filter((m) => m.shape.cpuKind === "performance");
		for (const family of [shared, perf]) {
			const costs = family.map((m) => m.costPerHourUsd);
			expect([...costs].sort((a, b) => a - b)).toEqual(costs);
		}
	});
});

describe("sameShape", () => {
	it("compares all three fields", () => {
		const a: MachineShape = { cpuKind: "shared", cpus: 1, memoryMb: 1024 };
		expect(sameShape(a, { ...a })).toBe(true);
		expect(sameShape(a, { ...a, memoryMb: 2048 })).toBe(false);
		expect(sameShape(a, { ...a, cpus: 2 })).toBe(false);
		expect(sameShape(a, { ...a, cpuKind: "performance" })).toBe(false);
	});
});
