/**
 * /mission-stats, /cost-series, /interactions, /message-events —
 * characterization tests written as part of the Sprint 28c route-table
 * extraction (issue #32). All four had no direct test before this.
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

const missionId = `monitor-trace-${randomUUID()}`;
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
			name: "Trace Route Test",
		} as TeamConfig["mission"],
		agents: [],
	});

	await conn.db.collection("missionStats").insertOne({
		missionId,
		agentId: "analyst",
		lifetimeCostUsd: 12.5,
		lifetimeLlmCallCount: 40,
		lifetimeTurnCount: 8,
	});

	await conn.db.collection("agentTurnStats").insertMany([
		{
			missionId,
			agentId: "analyst",
			turnNumber: 1,
			startedAt: new Date("2026-01-01T00:00:00Z"),
			completedAt: new Date("2026-01-01T00:01:00Z"),
			costUsd: 0.5,
			llmCallCount: 3,
			peakContextTokens: 1000,
			status: "completed",
		},
		{
			// No completedAt — an in-flight turn, must be excluded.
			missionId,
			agentId: "analyst",
			turnNumber: 2,
			startedAt: new Date("2026-01-01T00:02:00Z"),
		},
	]);

	await conn.db.collection("mailbox").insertMany([
		{
			missionId,
			from: "user",
			to: ["analyst"],
			subject: "hi",
			body: "hi",
			timestamp: new Date("2026-01-01T00:00:00Z"),
		},
		{
			missionId,
			from: "analyst",
			to: ["user"],
			subject: "re: hi",
			body: "hello back",
			timestamp: new Date("2026-01-01T00:00:01Z"),
		},
		{
			// Scheduler-delivered message: only createdAt, no timestamp — must
			// fall back via $ifNull rather than being dropped or dated null.
			missionId,
			from: "scheduler",
			to: ["analyst"],
			subject: "wakeup",
			body: "scheduled wakeup",
			createdAt: new Date("2026-01-01T00:00:02Z"),
		},
	]);

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
	for (const col of ["missions", "missionStats", "agentTurnStats", "mailbox"]) {
		await client?.db("magi-test").collection(col).deleteMany({ missionId });
	}
	await client?.close();
});

describe("GET /mission-stats", () => {
	it("returns the projected lifetime fields, no _id", async () => {
		const res = await fetch(`${base}/mission-stats`);
		expect(res.status).toBe(200);
		const docs = (await res.json()) as Array<Record<string, unknown>>;
		const doc = docs.find((d) => d.agentId === "analyst");
		expect(doc).toEqual({
			agentId: "analyst",
			lifetimeCostUsd: 12.5,
			lifetimeLlmCallCount: 40,
			lifetimeTurnCount: 8,
		});
	});
});

describe("GET /cost-series", () => {
	it("only returns turns with completedAt, sorted by completedAt", async () => {
		const res = await fetch(`${base}/cost-series`);
		expect(res.status).toBe(200);
		const docs = (await res.json()) as Array<{ turnNumber: number }>;
		expect(docs.length).toBe(1);
		expect(docs[0].turnNumber).toBe(1);
	});
});

describe("GET /interactions", () => {
	it("counts messages between agent pairs", async () => {
		const res = await fetch(`${base}/interactions`);
		expect(res.status).toBe(200);
		const docs = (await res.json()) as Array<{
			from: string;
			to: string;
			count: number;
		}>;
		const userToAnalyst = docs.find(
			(d) => d.from === "user" && d.to === "analyst",
		);
		expect(userToAnalyst?.count).toBe(1);
	});
});

describe("GET /message-events", () => {
	it("falls back to createdAt when timestamp is absent, sorted", async () => {
		const res = await fetch(`${base}/message-events`);
		expect(res.status).toBe(200);
		const docs = (await res.json()) as Array<{
			from: string;
			timestamp: string;
		}>;
		expect(docs.length).toBe(3);
		const scheduled = docs.find((d) => d.from === "scheduler");
		expect(scheduled).toBeDefined();
		expect(new Date(scheduled?.timestamp ?? 0).toISOString()).toBe(
			"2026-01-01T00:00:02.000Z",
		);
		// Sorted ascending by (possibly-fallback) timestamp.
		const times = docs.map((d) => new Date(d.timestamp).getTime());
		expect(times).toEqual([...times].sort((a, b) => a - b));
	});
});
