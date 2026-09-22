import { describe, expect, it } from "vitest";
import { fmtHours, fmtShape, fmtUsd, shapeKey } from "../src/RuntimePanel";

const HOUR_MS = 3_600_000;

describe("fmtHours", () => {
	it.each([
		[0, "0.0"],
		[0.5 * HOUR_MS, "0.5"],
		[9.94 * HOUR_MS, "9.9"],
		[10 * HOUR_MS, "10"],
		[23.9 * HOUR_MS, "24"],
	])("%s ms -> %s", (ms, expected) => {
		expect(fmtHours(ms)).toBe(expected);
	});
});

describe("fmtShape", () => {
	it("singular vs plural CPU count, whole and fractional GB", () => {
		expect(fmtShape({ cpuKind: "shared", cpus: 1, memoryMb: 1024 })).toBe(
			"shared, 1 CPU, 1 GB",
		);
		expect(fmtShape({ cpuKind: "performance", cpus: 4, memoryMb: 16384 })).toBe(
			"performance, 4 CPUs, 16 GB",
		);
		expect(fmtShape({ cpuKind: "shared", cpus: 1, memoryMb: 1536 })).toBe(
			"shared, 1 CPU, 1.5 GB",
		);
	});
});

describe("fmtUsd", () => {
	it("shows cents below $1 and whole dollars at or above $1, always with the ~ prefix", () => {
		expect(fmtUsd(0)).toBe("~$0.00");
		expect(fmtUsd(0.008)).toBe("~$0.01");
		expect(fmtUsd(0.999)).toBe("~$1.00");
		expect(fmtUsd(1)).toBe("~$1");
		expect(fmtUsd(42.6)).toBe("~$43");
	});
});

describe("shapeKey", () => {
	it("is stable for identical shapes and distinct across any differing field", () => {
		const a = { cpuKind: "shared", cpus: 1, memoryMb: 1024 };
		expect(shapeKey(a)).toBe(shapeKey({ ...a }));
		expect(shapeKey(a)).not.toBe(shapeKey({ ...a, cpus: 2 }));
		expect(shapeKey(a)).not.toBe(shapeKey({ ...a, memoryMb: 2048 }));
		expect(shapeKey(a)).not.toBe(shapeKey({ ...a, cpuKind: "performance" }));
	});
});
