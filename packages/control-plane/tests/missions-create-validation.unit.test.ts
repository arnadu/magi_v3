/**
 * missions.ts's creation routes reject unsafe caller-chosen input before
 * touching Mongo or Fly (2026-10-15 audit): MID1 (mission ids colliding with
 * platform namespaces such as `copilot-<userId>`). Fly and the lifecycle
 * layer are mocked; Mongo is the shared in-memory fake.
 */

import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { provisionTracked } from "../src/machine-lifecycle.js";
import { createMissionsRouter } from "../src/missions.js";
import { fakeDb } from "./support/fake-db.js";

vi.mock("../src/fly-machines.js", () => ({
	isLocalExecution: vi.fn(() => false),
	getMachineState: vi.fn(),
	machineExists: vi.fn(),
	volumeExists: vi.fn(),
	deleteMachine: vi.fn(),
	destroyLocal: vi.fn(),
	provisionLocal: vi.fn(),
}));
vi.mock("../src/machine-lifecycle.js", () => ({
	provisionTracked: vi.fn(),
	destroyTracked: vi.fn(),
}));

let server: Server | undefined;

async function startApp() {
	const { db, data } = fakeDb({ missions: [], machineSegments: [] });
	const app = express();
	app.use(express.json());
	app.use((req, _res, next) => {
		req.userId = "u1";
		req.isAdmin = false;
		next();
	});
	app.use("/api/missions", createMissionsRouter(db as never));
	server = await new Promise((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	const addr = server?.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	return { baseUrl: `http://127.0.0.1:${port}/api/missions`, data };
}

afterEach(() => {
	server?.close();
	server = undefined;
	vi.clearAllMocks();
});

const agents = [
	{
		id: "analyst",
		supervisor: "user",
		systemPrompt: "You are a helpful agent.",
		initialMentalMap: "<p>x</p>",
	},
];

describe("MID1: mission creation rejects reserved and malformed ids", () => {
	it.each([
		"copilot-admin",
		"copilot-AbC123xyz",
		"../x",
	])("POST / rejects %s with 400 and creates nothing", async (missionId) => {
		const { baseUrl, data } = await startApp();
		const res = await fetch(baseUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				missionId,
				name: "x",
				teamConfig: "inline",
				mission: { name: "x" },
				agents,
			}),
		});
		expect(res.status).toBe(400);
		expect(data.missions).toHaveLength(0);
		expect(vi.mocked(provisionTracked)).not.toHaveBeenCalled();
	});

	it("POST /draft rejects a copilot-namespace id with 400", async () => {
		const { baseUrl, data } = await startApp();
		const res = await fetch(`${baseUrl}/draft`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ missionId: "copilot-admin", name: "x" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/reserved/);
		expect(data.missions).toHaveLength(0);
	});
});

describe("spend containment at creation (ADR-0034)", () => {
	it("a mission created without a cap gets the default cap and the platform ceiling", async () => {
		const { baseUrl, data } = await startApp();
		vi.mocked(provisionTracked).mockResolvedValue({
			machineId: "mach",
			privateIp: "fdaa::1",
			volumeId: "vol",
		});
		const res = await fetch(baseUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				missionId: "capped-by-default",
				name: "x",
				teamConfig: "inline",
				mission: { name: "x" },
				agents,
			}),
		});
		expect(res.status).toBe(201);
		const doc = data.missions[0] as {
			mission: { maxCostUsd?: number };
			maxCostCeilingUsd?: number;
		};
		expect(doc.mission.maxCostUsd).toBe(25);
		expect(doc.maxCostCeilingUsd).toBe(100);
	});

	it("keeps an explicit cap and refuses a model the platform cannot price", async () => {
		const { baseUrl, data } = await startApp();
		const bad = await fetch(baseUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				missionId: "unknown-model",
				name: "x",
				teamConfig: "inline",
				mission: { name: "x", model: "nobody/such-model-v9", maxCostUsd: 7 },
				agents,
			}),
		});
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as { error: string }).error).toMatch(
			/unknown model id/,
		);
		expect(data.missions).toHaveLength(0);
	});
});
