/**
 * Mission-copilot GitHub proxy — token verification unit tests (ADR-0016).
 *
 * No HTTP server, no MongoDB. verifyMissionToken is a plain
 * (req, res, next) middleware function — faked directly, matching this
 * repo's existing mock-based test style rather than adding a supertest
 * dependency.
 */

import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyMissionToken } from "../src/mission-copilot-router.js";
import { deriveMonitorToken } from "../src/monitor-token.js";

function makeReq(opts: {
	missionId?: string;
	token?: string;
	inQuery?: boolean;
}): Request {
	const headers: Record<string, string> = {};
	if (opts.token !== undefined) headers["x-monitor-token"] = opts.token;
	return {
		body: opts.inQuery ? {} : { missionId: opts.missionId },
		query: opts.inQuery ? { missionId: opts.missionId } : {},
		headers,
	} as unknown as Request;
}

function makeRes() {
	const res = {
		statusCode: 200,
		body: undefined as unknown,
		status(code: number) {
			res.statusCode = code;
			return res;
		},
		json(payload: unknown) {
			res.body = payload;
			return res;
		},
	};
	return res as unknown as Response & typeof res;
}

describe("verifyMissionToken", () => {
	const ORIGINAL_KEY = process.env.MONITOR_SIGNING_KEY;

	beforeEach(() => {
		process.env.MONITOR_SIGNING_KEY = "test-signing-key";
	});
	afterEach(() => {
		if (ORIGINAL_KEY === undefined) {
			delete process.env.MONITOR_SIGNING_KEY;
		} else {
			process.env.MONITOR_SIGNING_KEY = ORIGINAL_KEY;
		}
	});

	it("400s when missionId is missing", () => {
		const req = makeReq({ token: "anything" });
		const res = makeRes();
		const next = vi.fn();
		verifyMissionToken(req, res, next);
		expect(res.statusCode).toBe(400);
		expect(next).not.toHaveBeenCalled();
	});

	it("calls next() when the token matches the derived value", () => {
		const missionId = "m1";
		const token = deriveMonitorToken(missionId);
		const req = makeReq({ missionId, token });
		const res = makeRes();
		const next = vi.fn();
		verifyMissionToken(req, res, next);
		expect(next).toHaveBeenCalledOnce();
		expect(res.statusCode).toBe(200); // unchanged — no error response written
	});

	it("401s when the token does not match", () => {
		const req = makeReq({ missionId: "m1", token: "wrong-token" });
		const res = makeRes();
		const next = vi.fn();
		verifyMissionToken(req, res, next);
		expect(res.statusCode).toBe(401);
		expect(next).not.toHaveBeenCalled();
	});

	it("401s when no token header is sent at all", () => {
		const req = makeReq({ missionId: "m1" });
		const res = makeRes();
		const next = vi.fn();
		verifyMissionToken(req, res, next);
		expect(res.statusCode).toBe(401);
		expect(next).not.toHaveBeenCalled();
	});

	it("accepts missionId from the query string (GET routes)", () => {
		const missionId = "m1";
		const token = deriveMonitorToken(missionId);
		const req = makeReq({ missionId, token, inQuery: true });
		const res = makeRes();
		const next = vi.fn();
		verifyMissionToken(req, res, next);
		expect(next).toHaveBeenCalledOnce();
	});

	// The single highest-severity behavior in this router: MonitorServer's own
	// tokenOk() fails *open* when MONITOR_SIGNING_KEY is unset (correct for
	// its loopback-only boundary). This router is public HTTPS and must do
	// the opposite — an unconfigured deployment must reject everything, not
	// accept everything.
	it("FAILS CLOSED when MONITOR_SIGNING_KEY is unset, even with a matching empty token", () => {
		delete process.env.MONITOR_SIGNING_KEY;
		// deriveMonitorToken("m1") now returns "" — confirm the empty string
		// is never treated as a valid credential.
		expect(deriveMonitorToken("m1")).toBe("");
		const req = makeReq({ missionId: "m1", token: "" });
		const res = makeRes();
		const next = vi.fn();
		verifyMissionToken(req, res, next);
		expect(res.statusCode).toBe(401);
		expect(next).not.toHaveBeenCalled();
	});

	it("FAILS CLOSED when MONITOR_SIGNING_KEY is unset and no token header is sent", () => {
		delete process.env.MONITOR_SIGNING_KEY;
		const req = makeReq({ missionId: "m1" });
		const res = makeRes();
		const next = vi.fn();
		verifyMissionToken(req, res, next);
		expect(res.statusCode).toBe(401);
		expect(next).not.toHaveBeenCalled();
	});
});
