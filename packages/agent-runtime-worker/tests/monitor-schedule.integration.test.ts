/**
 * DELETE /schedule/:id — characterization test written as part of the
 * Sprint 28c route-table extraction (issue #32). GET /schedule is already
 * covered indirectly by dashboard.integration.test.ts's real page load;
 * DELETE had no direct test before this.
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { TeamConfig } from "@magi/agent-config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

async function startMonitor(
	missionId: string,
	cancelSchedule?: (id: string) => Promise<void>,
): Promise<{
	monitor: MonitorServer;
	base: string;
	client: Awaited<ReturnType<typeof connectMongo>>["client"];
}> {
	const conn = await connectMongo(MONGODB_URI as string, "magi-test");
	await conn.db.collection("missions").insertOne({
		missionId,
		mission: {
			id: missionId,
			name: "Schedule Route Test",
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
		new Date(),
		process.cwd(),
		process.cwd(),
		cancelSchedule,
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
	await client?.close();
}

describe("DELETE /schedule/:id — no cancelSchedule configured", () => {
	const missionId = `monitor-schedule-nocancel-${randomUUID()}`;
	let monitor: MonitorServer;
	let base: string;
	let client: Awaited<ReturnType<typeof connectMongo>>["client"];

	beforeAll(async () => {
		({ monitor, base, client } = await startMonitor(missionId));
	}, 60_000);

	afterAll(async () => {
		monitor?.stop();
		await cleanup(client, missionId);
	});

	it("returns 501", async () => {
		const res = await fetch(`${base}/schedule/abc123`, { method: "DELETE" });
		expect(res.status).toBe(501);
		const json = (await res.json()) as { error: string };
		expect(json.error).toBe("cancelSchedule not configured");
	});
});

describe("DELETE /schedule/:id — cancelSchedule configured", () => {
	const missionId = `monitor-schedule-cancel-${randomUUID()}`;
	let monitor: MonitorServer;
	let base: string;
	let client: Awaited<ReturnType<typeof connectMongo>>["client"];
	const cancelSchedule = vi.fn(async (_id: string) => {});

	beforeAll(async () => {
		({ monitor, base, client } = await startMonitor(missionId, cancelSchedule));
	}, 60_000);

	afterAll(async () => {
		monitor?.stop();
		await cleanup(client, missionId);
	});

	it("returns 200 and calls cancelSchedule with the id", async () => {
		const res = await fetch(`${base}/schedule/abc123`, { method: "DELETE" });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean };
		expect(json.ok).toBe(true);
		expect(cancelSchedule).toHaveBeenCalledWith("abc123");
	});

	it("returns 500 with the error message when cancelSchedule throws", async () => {
		cancelSchedule.mockRejectedValueOnce(new Error("boom"));
		const res = await fetch(`${base}/schedule/def456`, { method: "DELETE" });
		expect(res.status).toBe(500);
		const json = (await res.json()) as { error: string };
		expect(json.error).toBe("boom");
	});
});
