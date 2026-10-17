/**
 * truncate() — the shared tool-output size cap every tool-providing file's
 * ok()/err() now routes through (see the tool-output size audit: most files
 * had independently reinvented a non-truncating copy).
 */

import { describe, expect, it } from "vitest";
import { truncate } from "../src/tools.js";

describe("truncate", () => {
	it("passes short text through unchanged", () => {
		expect(truncate("hello")).toBe("hello");
	});

	it("truncates at 20,000 chars with a clear marker", () => {
		const text = "a".repeat(25_000);
		const result = truncate(text);
		expect(result.length).toBeLessThan(text.length);
		expect(result).toContain("[Output truncated at 20000 chars]");
		expect(result.startsWith("a".repeat(20_000))).toBe(true);
	});

	it("truncates at 500 lines with a clear marker, even if under the char cap", () => {
		const text = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
		const result = truncate(text);
		expect(result).toContain(
			"[Output truncated: 600 lines total, showing first 500]",
		);
		expect(result.split("\n").length).toBe(501); // 500 kept lines + the marker line
	});

	it("the line-count check runs first — a text under 20,000 chars but over 500 lines is still truncated", () => {
		const text = Array.from({ length: 600 }, () => "x").join("\n"); // 1199 chars, way under MAX_CHARS
		const result = truncate(text);
		expect(result).toContain("lines total, showing first 500");
	});
});

describe("truncate applies both caps (T2)", () => {
	it("caps characters even when the line count is under the line cap", () => {
		const out = truncate("x".repeat(25_000));
		expect(out.length).toBeLessThan(20_200);
		expect(out).toContain("[Output truncated at 20000 chars");
	});

	it("caps characters after the line cap when the kept lines are still too long", () => {
		const out = truncate(
			Array.from({ length: 600 }, () => "y".repeat(100)).join("\n"),
		);
		expect(out.length).toBeLessThan(20_200);
		expect(out).toMatch(
			/\[Output truncated at 20000 chars; 600 lines total\]$/,
		);
	});

	it("reports only the line cap when the kept lines fit", () => {
		const out = truncate(
			Array.from({ length: 600 }, (_, i) => `l${i}`).join("\n"),
		);
		expect(out).toMatch(
			/\[Output truncated: 600 lines total, showing first 500\]$/,
		);
	});
});
