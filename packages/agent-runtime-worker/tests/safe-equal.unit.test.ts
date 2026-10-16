import { describe, expect, it } from "vitest";
import { requireMonitorToken, safeEqual } from "../src/safe-equal.js";

describe("safeEqual", () => {
	it("compares strings of any lengths without throwing", () => {
		expect(safeEqual("abc", "abc")).toBe(true);
		expect(safeEqual("abc", "abd")).toBe(false);
		expect(safeEqual("abc", "abcd")).toBe(false);
		expect(safeEqual("", "")).toBe(true);
		expect(safeEqual("", "x")).toBe(false);
	});
});

describe("requireMonitorToken", () => {
	it("returns the token when set", () => {
		expect(
			requireMonitorToken({
				MONITOR_TOKEN: "t0k",
				FLY_APP_NAME: "magi-missions-dev",
			}),
		).toBe("t0k");
	});

	it("allows an empty token off Fly (local developer daemon)", () => {
		expect(requireMonitorToken({})).toBe("");
		expect(requireMonitorToken({ MONITOR_TOKEN: "" })).toBe("");
	});

	it("refuses to start on Fly without a token — the monitor would be open to every machine in the app", () => {
		expect(() =>
			requireMonitorToken({ FLY_APP_NAME: "magi-missions-dev" }),
		).toThrow(/MONITOR_TOKEN is required on Fly/);
		expect(() =>
			requireMonitorToken({
				FLY_APP_NAME: "magi-missions-dev",
				MONITOR_TOKEN: "",
			}),
		).toThrow(/required on Fly/);
	});
});
