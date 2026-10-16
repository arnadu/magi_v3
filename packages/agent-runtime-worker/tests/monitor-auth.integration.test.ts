/**
 * MONITOR_TOKEN auth gate — the single, uniform check at the top of
 * `handleRequest` that applies to every non-GET route before any route-
 * specific logic runs (`packages/agent-runtime-worker/src/monitor-server.ts`).
 * Written ahead of the Sprint 28c route-table extraction (issue #32) so the
 * gate's exact current behavior is pinned before any route moves — this is
 * shared "middleware" logic that must keep applying globally, never get
 * duplicated per extracted route.
 *
 * Two separate MonitorServer instances are required: `monitorToken` is read
 * once via a class field initializer at construction time
 * (`process.env.MONITOR_TOKEN`), not per-request — setting/clearing the env
 * var after construction has no effect on an already-built instance.
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { TeamConfig } from "@magi/agent-config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createMongoAgentStatsRepository,
	StatsCollector,
} from "../src/agent-stats.js";
import { createMongoMailboxRepository } from "../src/mailbox.js";
import { createMongoMissionConfigRepository } from "../src/mission-config.js";
import { CLAUDE_SONNET } from "../src/models.js";
import { connectMongo } from "../src/mongo.js";
import { type AgentInfo, MonitorServer } from "../src/monitor-server.js";
import { UsageAccumulator } from "../src/usage.js";

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI)
	throw new Error("MONGODB_URI env var is required for integration tests");

function freePort(): Promise<number> {
	return new Promise((res) => {
		const s = createServer();
		s.listen(0, () => {
			const { port } = s.address() as { port: number };
			s.close(() => res(port));
		});
	});
}

function baseConfig(missionId: string): {
	mission: TeamConfig["mission"];
	agents: TeamConfig["agents"];
} {
	return {
		mission: { id: missionId, name: "Auth Gate Test" },
		agents: [
			{
				id: "analyst",
				name: "analyst",
				role: "analyst",
				supervisor: "user",
				systemPrompt: "You are a helpful agent.",
				initialMentalMap: '<section id="tasks"></section>',
			},
		],
	};
}

async function startMonitor(missionId: string): Promise<{
	monitor: MonitorServer;
	base: string;
	client: Awaited<ReturnType<typeof connectMongo>>["client"];
}> {
	const conn = await connectMongo(MONGODB_URI as string, "magi-test");
	await conn.db
		.collection("missions")
		.insertOne({ missionId, ...baseConfig(missionId) });

	const mailboxRepo = createMongoMailboxRepository(conn.db, missionId);
	const agents: AgentInfo[] = [
		{ id: "analyst", name: "Analyst", role: "assistant" },
	];
	const statsCollector = new StatsCollector(
		createMongoAgentStatsRepository(conn.db),
	);
	const missionConfigRepo = createMongoMissionConfigRepository(conn.db);
	const port = await freePort();
	const monitor = new MonitorServer(
		conn.db,
		missionId,
		"Test",
		CLAUDE_SONNET,
		new UsageAccumulator(),
		statsCollector,
		missionConfigRepo,
		mailboxRepo,
		agents,
		() => {},
	);
	await monitor.start(port);
	return { monitor, base: `http://127.0.0.1:${port}`, client: conn.client };
}

async function cleanup(
	client: Awaited<ReturnType<typeof connectMongo>>["client"],
	missionId: string,
): Promise<void> {
	await client
		?.db("magi-test")
		.collection("missions")
		.deleteMany({ missionId });
	await client?.db("magi-test").collection("mailbox").deleteMany({ missionId });
	await client?.close();
}

describe("MONITOR_TOKEN set", () => {
	const missionId = `monitor-auth-set-${randomUUID()}`;
	let monitor: MonitorServer;
	let base: string;
	let client: Awaited<ReturnType<typeof connectMongo>>["client"];
	const TOKEN = "test-token-xyz";

	beforeAll(async () => {
		process.env.MONITOR_TOKEN = TOKEN;
		({ monitor, base, client } = await startMonitor(missionId));
	}, 60_000);

	afterAll(async () => {
		delete process.env.MONITOR_TOKEN;
		monitor?.stop();
		await cleanup(client, missionId);
	});

	it("every registered route — GETs and SSE included — returns 401 without the token", async () => {
		// Enumerates the live route table so a route added later cannot be
		// unauthenticated by omission. Regex routes get a dummy segment; the
		// body/params do not matter because the gate runs before any handler.
		const routes = monitor.routeTable();
		expect(routes.length).toBeGreaterThan(20);
		for (const route of routes) {
			const paths = Array.isArray(route.path)
				? route.path
				: typeof route.path === "string"
					? [route.path]
					: [
							route.path.source
								.replace(/^\^|\$$/g, "")
								.replace(/\\\//g, "/")
								.replace(/\([^)]*\)/g, "x"),
						];
			for (const p of paths) {
				const res = await fetch(`${base}${p}`, {
					method: route.method,
					headers: { "content-type": "application/json" },
					body: route.method === "GET" ? undefined : "{}",
				});
				expect(res.status, `${route.method} ${p}`).toBe(401);
				await res.arrayBuffer();
			}
		}
	});

	it("a GET route succeeds with the correct token header", async () => {
		const res = await fetch(`${base}/status`, {
			headers: { "x-monitor-token": TOKEN },
		});
		expect(res.status).toBe(200);
	});

	it("a non-GET route returns 401 with no token header", async () => {
		const res = await fetch(`${base}/send-message`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				to: ["analyst"],
				subject: "x",
				message: "y",
			}),
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Unauthorized");
	});

	it("a non-GET route returns 401 with the wrong token header", async () => {
		const res = await fetch(`${base}/send-message`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-monitor-token": "wrong-token",
			},
			body: JSON.stringify({
				to: ["analyst"],
				subject: "x",
				message: "y",
			}),
		});
		expect(res.status).toBe(401);
	});

	it("a non-GET route succeeds with the correct token header", async () => {
		const res = await fetch(`${base}/send-message`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-monitor-token": TOKEN,
			},
			body: JSON.stringify({
				to: ["analyst"],
				subject: "x",
				message: "y",
			}),
		});
		expect(res.status).toBe(200);
	});
});

describe("MONITOR_TOKEN unset", () => {
	const missionId = `monitor-auth-unset-${randomUUID()}`;
	let monitor: MonitorServer;
	let base: string;
	let client: Awaited<ReturnType<typeof connectMongo>>["client"];

	beforeAll(async () => {
		delete process.env.MONITOR_TOKEN;
		({ monitor, base, client } = await startMonitor(missionId));
	}, 60_000);

	afterAll(async () => {
		monitor?.stop();
		await cleanup(client, missionId);
	});

	it("a non-GET route succeeds with no token header at all (gate is a no-op when unset)", async () => {
		const res = await fetch(`${base}/send-message`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				to: ["analyst"],
				subject: "x",
				message: "y",
			}),
		});
		expect(res.status).toBe(200);
	});
});
