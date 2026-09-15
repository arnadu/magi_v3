/**
 * GET /log — characterization test written as part of the Sprint 28c
 * route-table extraction (issue #32). Had no direct test before this.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const missionId = `monitor-log-${randomUUID()}`;
let client: Awaited<ReturnType<typeof connectMongo>>["client"];
let monitor: MonitorServer;
let base: string;
let workdir: string;

beforeAll(async () => {
	workdir = mkdtempSync(join(tmpdir(), "magi-monitor-log-test-"));
	const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`);
	writeFileSync(join(workdir, "daemon.log"), lines.join("\n"));

	const conn = await connectMongo(MONGODB_URI as string, "magi-test");
	client = conn.client;
	await conn.db.collection("missions").insertOne({
		missionId,
		mission: { id: missionId, name: "Log Route Test" } as TeamConfig["mission"],
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
		new Date(),
		workdir,
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
	rmSync(workdir, { recursive: true, force: true });
});

describe("GET /log", () => {
	it("defaults to the last 200 lines", async () => {
		const res = await fetch(`${base}/log`);
		expect(res.status).toBe(200);
		const body = await res.text();
		const lines = body.split("\n");
		expect(lines.length).toBe(200);
		expect(lines[0]).toBe("line 2801");
		expect(lines[lines.length - 1]).toBe("line 3000");
	});

	it("respects a ?lines= query param", async () => {
		const res = await fetch(`${base}/log?lines=5`);
		const body = await res.text();
		const lines = body.split("\n");
		expect(lines.length).toBe(5);
		expect(lines).toEqual([
			"line 2996",
			"line 2997",
			"line 2998",
			"line 2999",
			"line 3000",
		]);
	});

	it("caps ?lines= at 2000 even if a larger value is requested", async () => {
		const res = await fetch(`${base}/log?lines=999999`);
		const body = await res.text();
		expect(body.split("\n").length).toBe(2000);
	});

	it("returns an empty body (not an error) when the log file doesn't exist", async () => {
		// Reuses the already-running server/workdir from the outer beforeAll —
		// this is deliberately the last test in the file (order-dependent),
		// so removing the log file here doesn't affect the cases above.
		rmSync(join(workdir, "daemon.log"));
		const res = await fetch(`${base}/log`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("");
	});
});
