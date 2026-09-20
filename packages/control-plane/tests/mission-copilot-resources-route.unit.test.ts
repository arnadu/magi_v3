/**
 * Mission-copilot resource routes (ADR-0031): the real Express router and its
 * token middleware behind a local HTTP server, with the upgrade service
 * mocked. Proves the auth boundary and the request/response mapping.
 */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Db } from "mongodb";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createMissionCopilotRouter } from "../src/mission-copilot-router.js";
import { deriveMonitorToken } from "../src/monitor-token.js";
import { requestUpgrade, revertUpgrade } from "../src/resource-upgrade.js";

vi.mock("../src/resource-upgrade.js", () => ({
	requestUpgrade: vi.fn(),
	revertUpgrade: vi.fn(),
}));

const request = vi.mocked(requestUpgrade);
const revert = vi.mocked(revertUpgrade);

const DB = { marker: "db" } as unknown as Db;
let server: Server;
let base: string;
const savedKey = process.env.MONITOR_SIGNING_KEY;

beforeAll(async () => {
	const app = express();
	app.use(
		"/api/mission-copilot",
		express.json(),
		createMissionCopilotRouter(DB),
	);
	await new Promise<void>((resolve) => {
		server = app.listen(0, "127.0.0.1", resolve);
	});
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
	vi.resetAllMocks();
	process.env.MONITOR_SIGNING_KEY = "test-signing-key";
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	if (savedKey === undefined) delete process.env.MONITOR_SIGNING_KEY;
	else process.env.MONITOR_SIGNING_KEY = savedKey;
});

async function post(path: string, body: unknown, token?: string) {
	const res = await fetch(`${base}/api/mission-copilot${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(token === undefined ? {} : { "x-monitor-token": token }),
		},
		body: JSON.stringify(body),
	});
	return {
		status: res.status,
		body: (await res.json()) as Record<string, unknown>,
	};
}

const upgradeBody = {
	missionId: "m1",
	cpuKind: "performance",
	cpus: 2,
	memoryMb: 8192,
	durationMinutes: 30,
	reason: "big transform",
};

describe("POST /resources/upgrade", () => {
	it("passes the verified mission id and body to the service and relays its answer", async () => {
		request.mockResolvedValue({
			status: 200,
			body: { ok: true, action: "upgraded" },
		});
		const r = await post(
			"/resources/upgrade",
			upgradeBody,
			deriveMonitorToken("m1"),
		);

		expect(r).toEqual({ status: 200, body: { ok: true, action: "upgraded" } });
		expect(request).toHaveBeenCalledWith(DB, "m1", upgradeBody);
	});

	it("relays the service's rejections with their own status and message", async () => {
		request.mockResolvedValue({ status: 403, body: { error: "cap reached" } });
		const r = await post(
			"/resources/upgrade",
			upgradeBody,
			deriveMonitorToken("m1"),
		);
		expect(r).toEqual({ status: 403, body: { error: "cap reached" } });
	});

	it("rejects a request with no token, and never reaches the service", async () => {
		const r = await post("/resources/upgrade", upgradeBody);
		expect(r.status).toBe(401);
		expect(request).not.toHaveBeenCalled();
	});

	it("rejects another mission's token claiming this mission's id", async () => {
		const r = await post(
			"/resources/upgrade",
			upgradeBody,
			deriveMonitorToken("m2"),
		);
		expect(r.status).toBe(401);
		expect(request).not.toHaveBeenCalled();
	});

	it("fails closed when the control plane has no signing key", async () => {
		const token = deriveMonitorToken("m1");
		delete process.env.MONITOR_SIGNING_KEY;
		expect((await post("/resources/upgrade", upgradeBody, token)).status).toBe(
			401,
		);
		expect((await post("/resources/upgrade", upgradeBody, "")).status).toBe(
			401,
		);
		expect(request).not.toHaveBeenCalled();
	});

	it("400s a request that names no mission", async () => {
		const { missionId: _omit, ...noMission } = upgradeBody;
		const r = await post(
			"/resources/upgrade",
			noMission,
			deriveMonitorToken("m1"),
		);
		expect(r.status).toBe(400);
		expect(request).not.toHaveBeenCalled();
	});

	it("turns an unexpected failure into a generic 500 without leaking the cause", async () => {
		request.mockRejectedValue(new Error("mongodb://user:secret@host exploded"));
		const r = await post(
			"/resources/upgrade",
			upgradeBody,
			deriveMonitorToken("m1"),
		);
		expect(r.status).toBe(500);
		expect(JSON.stringify(r.body)).not.toContain("secret");
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining('missionId: "m1"'),
		);
	});
});

describe("POST /resources/revert", () => {
	it("reverts on request for the token's mission", async () => {
		revert.mockResolvedValue({
			status: 200,
			body: { ok: true, action: "reverted" },
		});
		const r = await post(
			"/resources/revert",
			{ missionId: "m1" },
			deriveMonitorToken("m1"),
		);

		expect(r.status).toBe(200);
		expect(revert).toHaveBeenCalledWith(DB, "m1", { reason: "requested" });
	});

	it("is protected by the same token check", async () => {
		const r = await post(
			"/resources/revert",
			{ missionId: "m1" },
			deriveMonitorToken("other"),
		);
		expect(r.status).toBe(401);
		expect(revert).not.toHaveBeenCalled();
	});
});
