import { describe, expect, it } from "vitest";
import { FailedAuthLimiter } from "../src/auth-limiter.js";
import {
	needsRevocationCheck,
	REVOCATION_RECHECK_MS,
} from "../src/firebase.js";

describe("FailedAuthLimiter (AUTH-BF)", () => {
	it("blocks a client after maxFailures within the window and releases it afterwards", () => {
		let t = 1_000_000;
		const l = new FailedAuthLimiter({
			maxFailures: 3,
			windowMs: 60_000,
			now: () => t,
		});
		l.fail("1.2.3.4");
		l.fail("1.2.3.4");
		expect(l.isBlocked("1.2.3.4")).toBe(false);
		l.fail("1.2.3.4");
		expect(l.isBlocked("1.2.3.4")).toBe(true);
		expect(l.retryAfterSeconds("1.2.3.4")).toBeGreaterThan(0);
		expect(l.isBlocked("5.6.7.8")).toBe(false);
		t += 60_001;
		expect(l.isBlocked("1.2.3.4")).toBe(false);
	});

	it("bounds the number of tracked clients", () => {
		const l = new FailedAuthLimiter({ maxEntries: 2 });
		l.fail("a");
		l.fail("b");
		l.fail("c");
		expect(l.isBlocked("a")).toBe(false); // evicted, not blocked
	});
});

describe("needsRevocationCheck (AUTH2)", () => {
	it("checks a token once per recheck window", () => {
		const seen = new Map<string, number>();
		expect(needsRevocationCheck("tok", 0, seen)).toBe(true);
		expect(needsRevocationCheck("tok", 1_000, seen)).toBe(false);
		expect(needsRevocationCheck("tok", REVOCATION_RECHECK_MS + 1, seen)).toBe(
			true,
		);
		expect(needsRevocationCheck("other", 2_000, seen)).toBe(true);
	});
});
