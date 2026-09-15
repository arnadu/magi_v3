/**
 * POST /pause-agent, /resume-agent — characterization tests written as part
 * of the Sprint 28c route-table extraction (issue #32). Previously
 * untested at the HTTP level.
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

const missionId = `monitor-pauseresume-${randomUUID()}`;
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
			name: "Pause/Resume Route Test",
		} as TeamConfig["mission"],
		agents: [],
	});

	const mailboxRepo = createMongoMailboxRepository(conn.db, missionId);
	const agents: AgentInfo[] = [
		{ id: "analyst", name: "Analyst", role: "analyst" },
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
	await client?.close();
});

describe("POST /pause-agent", () => {
	it("400s with no agentId", async () => {
		const res = await fetch(`${base}/pause-agent`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it("404s for an unknown agent", async () => {
		const res = await fetch(`${base}/pause-agent`, {
			method: "POST",
			body: JSON.stringify({ agentId: "no-such-agent" }),
		});
		expect(res.status).toBe(404);
	});

	it("pauses a known agent and returns the paused list", async () => {
		const res = await fetch(`${base}/pause-agent`, {
			method: "POST",
			body: JSON.stringify({ agentId: "analyst" }),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean; paused: string[] };
		expect(json).toEqual({ ok: true, paused: ["analyst"] });
	});
});

describe("POST /resume-agent", () => {
	it("lifts the pause set by /pause-agent above", async () => {
		const res = await fetch(`${base}/resume-agent`, {
			method: "POST",
			body: JSON.stringify({ agentId: "analyst" }),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean; paused: string[] };
		expect(json).toEqual({ ok: true, paused: [] });
	});
});
