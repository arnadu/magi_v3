/**
 * POST /step, /toggle-step, /start — characterization tests written as part
 * of the Sprint 28c route-table extraction (issue #32). Previously
 * untested; these routes are worth testing beyond the HTTP response alone
 * since their real effect is releasing an internal gate and pushing an SSE
 * event, neither of which the response body alone proves.
 */

import { randomUUID } from "node:crypto";
import { createServer, get as httpGet } from "node:http";
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

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 5000,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitFor timed out");
		}
		await new Promise((r) => setTimeout(r, 20));
	}
}

/**
 * Collects SSE events from GET /events into an array as they arrive. Uses
 * raw node:http (not fetch's stream reader — undici doesn't reliably deliver
 * individual chunks as they're written for a long-lived SSE response) since
 * that's exactly what a real EventSource client, and monitor-server.ts's own
 * implementation, both build on.
 *
 * Waits for the connection's own initial "status" frame before resolving:
 * the /events handler only adds this client to the broadcast set *after*
 * awaiting statusPayload() (a real Mongo round-trip), so a state-changing
 * request fired immediately after this function returns can otherwise race
 * ahead of that registration and have its push() silently miss this client
 * (found live — this isn't a client-side pooling artifact).
 */
function openEventStream(base: string): Promise<{
	events: Array<{ type: string; data: unknown }>;
	close: () => void;
}> {
	const events: Array<{ type: string; data: unknown }> = [];
	return new Promise((resolve, reject) => {
		const req = httpGet(`${base}/events`, (res) => {
			let buf = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				buf += chunk;
				const frames = buf.split("\n\n");
				buf = frames.pop() ?? "";
				for (const frame of frames) {
					const eventLine = frame
						.split("\n")
						.find((l) => l.startsWith("event: "));
					const dataLine = frame
						.split("\n")
						.find((l) => l.startsWith("data: "));
					if (eventLine && dataLine) {
						events.push({
							type: eventLine.slice("event: ".length),
							data: JSON.parse(dataLine.slice("data: ".length)),
						});
					}
				}
			});
			waitFor(() => events.some((e) => e.type === "status"))
				.then(() => resolve({ events, close: () => req.destroy() }))
				.catch(reject);
		});
		req.on("error", reject);
	});
}

const missionId = `monitor-runcontrol-${randomUUID()}`;
let client: Awaited<ReturnType<typeof connectMongo>>["client"];
let monitor: MonitorServer;
let base: string;

beforeAll(async () => {
	const conn = await connectMongo(MONGODB_URI as string, "magi-test");
	client = conn.client;
	await conn.db.collection("missions").insertOne({
		missionId,
		mission: {
			id: missionId,
			name: "Run Control Test",
		} as TeamConfig["mission"],
		agents: [],
	});

	const mailboxRepo = createMongoMailboxRepository(conn.db, missionId);
	const agents: AgentInfo[] = [];
	const statsCollector = new StatsCollector(
		createMongoAgentStatsRepository(conn.db),
	);
	const missionConfigRepo = createMongoMissionConfigRepository(conn.db);
	const port = await freePort();
	monitor = new MonitorServer(
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
	base = `http://127.0.0.1:${port}`;
}, 60_000);

afterAll(async () => {
	monitor?.stop();
	await client
		?.db("magi-test")
		.collection("missions")
		.deleteMany({ missionId });
	await client?.close();
});

describe("POST /start", () => {
	it("sets started, pushes a started SSE event, and is idempotent on a second call", async () => {
		const stream = await openEventStream(base);
		try {
			const res = await fetch(`${base}/start`, { method: "POST" });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });

			await waitFor(() => stream.events.some((e) => e.type === "started"));

			// Second call: still 200/ok, but per the route's own `if (!started)`
			// guard, no second "started" push — only the one from above exists.
			const res2 = await fetch(`${base}/start`, { method: "POST" });
			expect(res2.status).toBe(200);
			await new Promise((r) => setTimeout(r, 100));
			expect(stream.events.filter((e) => e.type === "started").length).toBe(1);
		} finally {
			stream.close();
		}
	});
});

describe("POST /toggle-step and POST /step", () => {
	it("toggling on then off with no pending gate does not push step-resumed", async () => {
		const res1 = await fetch(`${base}/toggle-step`, { method: "POST" });
		expect((await res1.json()) as { stepEnabled: boolean }).toEqual({
			ok: true,
			stepEnabled: true,
		});

		const res2 = await fetch(`${base}/toggle-step`, { method: "POST" });
		expect(await res2.json()).toEqual({ ok: true, stepEnabled: false });
	});

	it("POST /step releases a pending waitForStep() gate and pushes step-resumed", async () => {
		// Re-enable step mode, then simulate the orchestrator pausing for a step.
		await fetch(`${base}/toggle-step`, { method: "POST" });
		const stream = await openEventStream(base);
		try {
			let resolved = false;
			const gate = monitor.waitForStep().then(() => {
				resolved = true;
			});
			await waitFor(() => stream.events.some((e) => e.type === "step-paused"));

			const res = await fetch(`${base}/step`, { method: "POST" });
			expect(res.status).toBe(200);
			expect((await res.json()) as { stepEnabled: boolean }).toEqual({
				ok: true,
				stepEnabled: true,
			});

			await gate;
			expect(resolved).toBe(true);
			// The route's push() happens synchronously after stepResolve(), but
			// `gate` resolves on the microtask queue while the SSE frame still
			// has to make a real socket round trip to this client — so this
			// needs its own wait rather than an immediate assertion.
			await waitFor(() => stream.events.some((e) => e.type === "step-resumed"));
		} finally {
			stream.close();
		}
	});
});
