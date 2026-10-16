/**
 * Per-mission monitor token derivation and the request header every
 * control-plane → monitor-server call carries (F-042: GETs included).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	deriveMonitorToken,
	monitorAuthHeaders,
} from "../src/monitor-token.js";

const saved = process.env.MONITOR_SIGNING_KEY;
afterEach(() => {
	if (saved === undefined) delete process.env.MONITOR_SIGNING_KEY;
	else process.env.MONITOR_SIGNING_KEY = saved;
});

describe("deriveMonitorToken", () => {
	it("is deterministic per mission and differs between missions", () => {
		process.env.MONITOR_SIGNING_KEY = "k1";
		const a = deriveMonitorToken("mission-a");
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(deriveMonitorToken("mission-a")).toBe(a);
		expect(deriveMonitorToken("mission-b")).not.toBe(a);
	});

	it("changes with the signing key (rotation re-issues every token)", () => {
		process.env.MONITOR_SIGNING_KEY = "k1";
		const a = deriveMonitorToken("m");
		process.env.MONITOR_SIGNING_KEY = "k2";
		expect(deriveMonitorToken("m")).not.toBe(a);
	});

	it("is empty with no signing key (local dev)", () => {
		delete process.env.MONITOR_SIGNING_KEY;
		expect(deriveMonitorToken("m")).toBe("");
	});
});

describe("monitorAuthHeaders", () => {
	it("carries the token when a key is configured and nothing otherwise", () => {
		process.env.MONITOR_SIGNING_KEY = "k1";
		expect(monitorAuthHeaders("m")).toEqual({
			"x-monitor-token": deriveMonitorToken("m"),
		});
		delete process.env.MONITOR_SIGNING_KEY;
		expect(monitorAuthHeaders("m")).toEqual({});
	});
});
