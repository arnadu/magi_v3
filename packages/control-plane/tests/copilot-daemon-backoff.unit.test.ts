import { describe, expect, it } from "vitest";
import { turnFailureBackoffMs } from "../src/copilot-daemon.js";

describe("turnFailureBackoffMs (CD1 / #55)", () => {
	it("grows exponentially from 30 s and caps at 5 min", () => {
		expect(turnFailureBackoffMs(1, "boom")).toBe(30_000);
		expect(turnFailureBackoffMs(2, "boom")).toBe(60_000);
		expect(turnFailureBackoffMs(4, "boom")).toBe(240_000);
		expect(turnFailureBackoffMs(9, "boom")).toBe(300_000);
	});

	it("honours a provider Retry-After when it is longer", () => {
		const msg =
			'402: {"message":"This request would exceed your available credits","metadata":{"headers":{"Retry-After":"120"}}}';
		expect(turnFailureBackoffMs(1, msg)).toBe(120_000);
		expect(turnFailureBackoffMs(5, msg)).toBe(300_000);
	});
});
