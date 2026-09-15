/**
 * GET /mailbox — characterization test written as part of the Sprint 28c
 * route-table extraction (issue #32). POST /send-message is already covered
 * by dashboard.integration.test.ts's real compose-send round trip; the GET
 * side had no direct test before this.
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

const missionId = `monitor-mailbox-${randomUUID()}`;
let client: Awaited<ReturnType<typeof connectMongo>>["client"];
let monitor: MonitorServer;
let base: string;
let mailboxRepo: ReturnType<typeof createMongoMailboxRepository>;

beforeAll(async () => {
	const conn = await connectMongo(MONGODB_URI as string, "magi-test");
	client = conn.client;
	await conn.db.collection("missions").insertOne({
		missionId,
		mission: {
			id: missionId,
			name: "Mailbox Route Test",
		} as TeamConfig["mission"],
		agents: [],
	});

	mailboxRepo = createMongoMailboxRepository(conn.db, missionId);
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
	await client?.db("magi-test").collection("mailbox").deleteMany({ missionId });
	await client?.close();
});

describe("GET /mailbox", () => {
	it("returns posted messages with the documented JSON shape", async () => {
		await mailboxRepo.post({
			missionId,
			from: "user",
			to: ["analyst"],
			subject: "Test subject",
			body: "Short body",
		});

		const res = await fetch(`${base}/mailbox`);
		expect(res.status).toBe(200);
		const payload = (await res.json()) as Array<{
			id: string;
			from: string;
			to: string[];
			subject: string;
			bodyPreview: string;
			body: string;
			timestamp: string;
		}>;
		const msg = payload.find((m) => m.subject === "Test subject");
		expect(msg).toBeDefined();
		expect(msg?.from).toBe("user");
		expect(msg?.to).toEqual(["analyst"]);
		expect(msg?.body).toBe("Short body");
		expect(msg?.bodyPreview).toBe("Short body");
		expect(typeof msg?.timestamp).toBe("string");
	});

	it("truncates bodyPreview to 400 chars with an ellipsis, but keeps the full body", async () => {
		const longBody = "x".repeat(500);
		await mailboxRepo.post({
			missionId,
			from: "user",
			to: ["analyst"],
			subject: "Long body test",
			body: longBody,
		});

		const res = await fetch(`${base}/mailbox`);
		const payload = (await res.json()) as Array<{
			subject: string;
			bodyPreview: string;
			body: string;
		}>;
		const msg = payload.find((m) => m.subject === "Long body test");
		expect(msg).toBeDefined();
		expect(msg?.body).toBe(longBody);
		expect(msg?.bodyPreview).toBe(`${"x".repeat(400)}…`);
		expect(msg?.bodyPreview.length).toBe(401);
	});
});
