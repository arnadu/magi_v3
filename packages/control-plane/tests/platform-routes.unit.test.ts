import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@magi/agent-runtime-worker", async (importOriginal) => ({
	...(await importOriginal<typeof import("@magi/agent-runtime-worker")>()),
	fetchOpenRouterCatalog: vi.fn(async () => [
		{ id: "deepseek/deepseek-chat", name: "DeepSeek" },
	]),
}));

import {
	ANTHROPIC_MODELS,
	createPlatformRoutes,
} from "../src/platform-routes.js";
import { fakeDb } from "./support/fake-db.js";

let server: Server | undefined;
afterEach(
	() =>
		new Promise<void>((r) => {
			if (!server) return r();
			server.close(() => r());
			server = undefined;
		}),
);

/** The router behind a stand-in for requireAuth that sets the caller. */
async function serve(
	data: Record<string, Record<string, unknown>[]>,
	caller: { userId: string; isAdmin: boolean },
): Promise<string> {
	const { db } = fakeDb(data);
	const app = express();
	app.use((req, _res, next) => {
		req.userId = caller.userId;
		req.isAdmin = caller.isAdmin;
		next();
	});
	app.use(createPlatformRoutes(db));
	await new Promise<void>((r) => {
		server = app.listen(0, "127.0.0.1", r);
	});
	return `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
}

const DATA = {
	missions: [
		{ missionId: "m1", name: "Mine", userId: "u1" },
		{ missionId: "m2", name: "Theirs", userId: "u2" },
	],
	missionStats: [
		{
			missionId: "m1",
			agentId: "lead",
			lifetimeCostUsd: 1.5,
			lifetimeLlmCallCount: 3,
		},
		{
			missionId: "m1",
			agentId: "analyst",
			lifetimeCostUsd: 0.5,
			lifetimeLlmCallCount: 2,
		},
	],
};

describe("GET /api/usage", () => {
	it("returns the caller's missions with summed lifetime usage, zero when none is recorded", async () => {
		const base = await serve(DATA, { userId: "u1", isAdmin: false });
		const body = await (await fetch(`${base}/api/usage`)).json();
		expect(body).toEqual([
			{
				missionId: "m1",
				name: "Mine",
				userId: "u1",
				usage: { totalCostUsd: 2, calls: 5 },
			},
		]);
	});

	it("returns every mission to an admin", async () => {
		const base = await serve(DATA, { userId: "admin", isAdmin: true });
		const body = (await (await fetch(`${base}/api/usage`)).json()) as {
			missionId: string;
			usage: { totalCostUsd: number };
		}[];
		expect(body.map((m) => m.missionId).sort()).toEqual(["m1", "m2"]);
		expect(body.find((m) => m.missionId === "m2")?.usage.totalCostUsd).toBe(0);
	});
});

describe("GET /api/models", () => {
	it("lists the first-party Anthropic models and the OpenRouter catalog", async () => {
		const base = await serve({}, { userId: "u1", isAdmin: false });
		const body = await (await fetch(`${base}/api/models`)).json();
		expect(body.anthropic).toEqual(ANTHROPIC_MODELS);
		expect(body.anthropic).toHaveLength(3);
		expect(body.openrouter).toEqual([
			{ id: "deepseek/deepseek-chat", name: "DeepSeek" },
		]);
	});
});
