/**
 * auth.ts credential extraction and the constant-time compare used for the
 * admin key and (via mission-copilot-router) the per-mission monitor token.
 */

import { describe, expect, it } from "vitest";
import { extractBearer, extractCookie, safeEqual } from "../src/auth.js";

describe("safeEqual", () => {
	it("compares equal and unequal strings of any lengths without throwing", () => {
		expect(safeEqual("abc", "abc")).toBe(true);
		expect(safeEqual("abc", "abd")).toBe(false);
		expect(safeEqual("abc", "abcd")).toBe(false);
		expect(safeEqual("", "")).toBe(true);
		expect(safeEqual("", "x")).toBe(false);
	});
});

describe("extractBearer", () => {
	it("returns the token after the Bearer scheme and nothing for other shapes", () => {
		expect(extractBearer("Bearer abc.def")).toBe("abc.def");
		expect(extractBearer("bearer abc")).toBeUndefined();
		expect(extractBearer("Basic abc")).toBeUndefined();
		expect(extractBearer(undefined)).toBeUndefined();
	});
});

describe("extractCookie", () => {
	it("finds the named cookie among several, trimming whitespace", () => {
		expect(extractCookie("a=1; magi_session=tok-1; b=2", "magi_session")).toBe(
			"tok-1",
		);
		expect(extractCookie("magi_session=only", "magi_session")).toBe("only");
	});

	it("returns undefined when absent, malformed or without a header", () => {
		expect(extractCookie("a=1; b=2", "magi_session")).toBeUndefined();
		expect(extractCookie("magi_session", "magi_session")).toBeUndefined();
		expect(extractCookie(undefined, "magi_session")).toBeUndefined();
	});

	it("does not match a cookie whose name merely contains the wanted name", () => {
		expect(extractCookie("xmagi_session=no", "magi_session")).toBeUndefined();
	});
});
