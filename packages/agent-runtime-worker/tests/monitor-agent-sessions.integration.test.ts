/**
 * /agents/:id/{mental-map,sessions,sessions/:turn,usage} — characterization
 * tests written as part of the Sprint 28c route-table extraction (issue
 * #32). This cluster had no direct HTTP-level test before this and is the
 * largest chunk of genuinely inline (non-delegated) aggregation logic in
 * monitor-server.ts.
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

const missionId = `monitor-sessions-${randomUUID()}`;
const agentId = "analyst";
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
			name: "Agent Sessions Test",
		} as TeamConfig["mission"],
		agents: [],
	});

	const mailboxRepo = createMongoMailboxRepository(conn.db, missionId);
	const agents: AgentInfo[] = [
		{ id: agentId, name: agentId, role: "assistant" },
	];
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
	for (const col of ["conversationMessages", "llmCallLog"]) {
		await client?.db("magi-test").collection(col).deleteMany({ missionId });
	}
	await client?.close();
});

describe("GET /agents/:id/mental-map", () => {
	it("returns an empty html string when no snapshot exists yet", async () => {
		const res = await fetch(`${base}/agents/${agentId}/mental-map`);
		expect(res.status).toBe(200);
		const json = (await res.json()) as { agentId: string; html: string };
		expect(json.agentId).toBe(agentId);
		expect(json.html).toBe("");
	});

	it("returns the most recent snapshot by turnNumber then seqInTurn", async () => {
		const db = client.db("magi-test");
		await db.collection("conversationMessages").insertMany([
			{
				missionId,
				agentId,
				turnNumber: 1,
				seqInTurn: 1,
				mentalMapHtml: "<p>old</p>",
				message: { role: "assistant", content: [] },
			},
			{
				missionId,
				agentId,
				turnNumber: 2,
				seqInTurn: 1,
				mentalMapHtml: "<p>newer, lower seq</p>",
				message: { role: "assistant", content: [] },
			},
			{
				missionId,
				agentId,
				turnNumber: 2,
				seqInTurn: 3,
				mentalMapHtml: "<p>newest</p>",
				message: { role: "assistant", content: [] },
			},
		]);

		const res = await fetch(`${base}/agents/${agentId}/mental-map`);
		const json = (await res.json()) as { html: string };
		expect(json.html).toBe("<p>newest</p>");
	});
});

describe("GET /agents/:id/sessions and /sessions/:turn", () => {
	beforeAll(async () => {
		const db = client.db("magi-test");
		await db.collection("llmCallLog").insertMany([
			{
				missionId,
				agentId,
				turnNumber: 5,
				isReflection: false,
				savedAt: new Date("2026-01-01T00:00:00Z"),
				usage: {
					inputTokens: 100,
					outputTokens: 50,
					cacheReadTokens: 10,
					cost: { total: 0.01 },
				},
			},
			{
				missionId,
				agentId,
				turnNumber: 5,
				isReflection: false,
				savedAt: new Date("2026-01-01T00:00:05Z"),
				usage: {
					inputTokens: 200,
					outputTokens: 75,
					cacheReadTokens: 20,
					cost: { total: 0.02 },
				},
			},
		]);
		await db.collection("conversationMessages").insertMany([
			{
				missionId,
				agentId,
				turnNumber: 5,
				seqInTurn: 1,
				message: { role: "toolResult", content: [] },
			},
			{
				missionId,
				agentId,
				turnNumber: 5,
				seqInTurn: 2,
				message: { role: "toolResult", content: [] },
			},
		]);
	});

	it("GET /agents/:id/sessions aggregates per turn: totals, llmCalls, toolCalls, duration", async () => {
		const res = await fetch(`${base}/agents/${agentId}/sessions`);
		expect(res.status).toBe(200);
		const sessions = (await res.json()) as Array<{
			turnNumber: number;
			llmCalls: number;
			toolCalls: number;
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens: number;
			costUsd: number;
			durationMs: number;
		}>;
		const turn5 = sessions.find((s) => s.turnNumber === 5);
		expect(turn5).toBeDefined();
		expect(turn5?.llmCalls).toBe(2);
		expect(turn5?.toolCalls).toBe(2);
		expect(turn5?.inputTokens).toBe(300);
		expect(turn5?.outputTokens).toBe(125);
		expect(turn5?.cacheReadTokens).toBe(30);
		expect(turn5?.costUsd).toBeCloseTo(0.03, 8);
		expect(turn5?.durationMs).toBe(5000);
	});

	it("GET /agents/:id/sessions/:turn returns that turn's raw messages and llmCalls", async () => {
		const res = await fetch(`${base}/agents/${agentId}/sessions/5`);
		expect(res.status).toBe(200);
		const detail = (await res.json()) as {
			turnNumber: number;
			messages: unknown[];
			llmCalls: unknown[];
		};
		expect(detail.turnNumber).toBe(5);
		expect(detail.messages.length).toBe(2);
		expect(detail.llmCalls.length).toBe(2);
	});
});

describe("GET /agents/:id/usage", () => {
	it("maps llmCallLog entries, defaulting turnNumber/isReflection and degrading toolNames", async () => {
		const res = await fetch(`${base}/agents/${agentId}/usage`);
		expect(res.status).toBe(200);
		const docs = (await res.json()) as Array<{
			turnNumber: number;
			isReflection: boolean;
			model: string | null;
			toolNames?: string[];
			usage: unknown;
		}>;
		expect(docs.length).toBeGreaterThanOrEqual(2);
		for (const d of docs) {
			expect(typeof d.turnNumber).toBe("number");
			expect(typeof d.isReflection).toBe("boolean");
			// None of the seeded docs set input.toolNames, so it must degrade to
			// undefined (not an empty array) per the route's own documented
			// retention-window distinction.
			expect(d.toolNames).toBeUndefined();
		}
	});
});
