import { describe, expect, it } from "vitest";
import { configChangedSince } from "../src/config-version.js";

describe("configChangedSince", () => {
	const t = new Date("2026-10-17T10:00:00.000Z");
	it("passes when no expectation was sent or the document never had updatedAt", () => {
		expect(configChangedSince(t, undefined)).toBeNull();
		expect(configChangedSince(undefined, t.toISOString())).toBeNull();
	});
	it("passes when the loaded and current timestamps agree", () => {
		expect(configChangedSince(t, t.toISOString())).toBeNull();
	});
	it("refuses when the document moved, and rejects an unparsable expectation", () => {
		expect(
			configChangedSince(new Date(t.getTime() + 1), t.toISOString()),
		).toMatch(/changed since you loaded it/);
		expect(configChangedSince(t, "yesterday")).toMatch(/not a date/);
	});
});
