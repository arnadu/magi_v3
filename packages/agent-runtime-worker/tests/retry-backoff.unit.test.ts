import { describe, expect, it } from "vitest";
import { failureBackoffMs } from "../src/retry-backoff.js";

describe("failureBackoffMs", () => {
	it("doubles from the base, caps, and honours a longer Retry-After", () => {
		expect(failureBackoffMs(1, "x")).toBe(30_000);
		expect(failureBackoffMs(3, "x")).toBe(120_000);
		expect(failureBackoffMs(20, "x")).toBe(300_000);
		expect(failureBackoffMs(1, '"Retry-After":"120"')).toBe(120_000);
		expect(failureBackoffMs(1, "Retry-After: 99999")).toBe(600_000);
		expect(failureBackoffMs(1, "x", { baseMs: 1_000, maxMs: 4_000 })).toBe(
			1_000,
		);
		expect(failureBackoffMs(5, "x", { baseMs: 1_000, maxMs: 4_000 })).toBe(
			4_000,
		);
	});
});
