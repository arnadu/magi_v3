/**
 * ADR-0018 — /set-budget and /extend-budget against a real MonitorServer +
 * MongoDB. No LLM calls.
 *
 * Before this ADR, these routes only mutated an in-memory `currentCapUsd` —
 * a cap set here (e.g. by the mission copilot's SetMissionSpendCap tool,
 * which calls /set-budget directly) was invisible to Mongo-based reads and
 * lost on daemon restart. This proves both routes now persist to the same
 * `missions.teamConfigYaml` field the cockpit's Limits panel reads/writes.
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { parseTeamConfig } from "@magi/agent-config";
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

const baseYaml = (missionId: string) => `
mission:
  id: ${missionId}
  name: Budget Route Test

agents:
  - id: analyst
    supervisor: user
    systemPrompt: You are a helpful agent.
    initialMentalMap: <section id="tasks"></section>
`;

const missionId = `monitor-budget-${randomUUID()}`;
let client: Awaited<ReturnType<typeof connectMongo>>["client"];
let monitor: MonitorServer;
let base: string;

beforeAll(async () => {
	const conn = await connectMongo(MONGODB_URI, "magi-test");
	client = conn.client;
	await conn.db
		.collection("missions")
		.insertOne({ missionId, teamConfigYaml: baseYaml(missionId) });

	const mailboxRepo = createMongoMailboxRepository(conn.db, missionId);
	const agents: AgentInfo[] = [
		{ id: "analyst", name: "Analyst", role: "assistant" },
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

describe("POST /set-budget", () => {
	it("persists the cap to missions.teamConfigYaml, not just in-memory", async () => {
		const res = await fetch(`${base}/set-budget`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ capUsd: 42.5 }),
		});
		expect(res.ok).toBe(true);

		const doc = await client
			.db("magi-test")
			.collection("missions")
			.findOne({ missionId });
		const config = parseTeamConfig(doc?.teamConfigYaml as string);
		expect(config.mission.maxCostUsd).toBeCloseTo(42.5, 8);
	});

	it("/status reflects the persisted cap (read fresh, not from a local field)", async () => {
		const res = await fetch(`${base}/status`);
		const status = (await res.json()) as { maxCostUsd: number | null };
		expect(status.maxCostUsd).toBeCloseTo(42.5, 8);
	});

	it("rejects a non-positive cap and leaves the persisted value unchanged", async () => {
		const res = await fetch(`${base}/set-budget`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ capUsd: -5 }),
		});
		expect(res.status).toBe(400);

		const doc = await client
			.db("magi-test")
			.collection("missions")
			.findOne({ missionId });
		const config = parseTeamConfig(doc?.teamConfigYaml as string);
		expect(config.mission.maxCostUsd).toBeCloseTo(42.5, 8);
	});
});

describe("POST /extend-budget", () => {
	it("adds to the persisted cap, reading the current value fresh first", async () => {
		const res = await fetch(`${base}/extend-budget`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ addUsd: 10 }),
		});
		expect(res.ok).toBe(true);
		const body = (await res.json()) as { newCapUsd: number };
		expect(body.newCapUsd).toBeCloseTo(52.5, 8);

		const doc = await client
			.db("magi-test")
			.collection("missions")
			.findOne({ missionId });
		const config = parseTeamConfig(doc?.teamConfigYaml as string);
		expect(config.mission.maxCostUsd).toBeCloseTo(52.5, 8);
	});
});

describe("budget pause / resume", () => {
	it("notifyCostPause sets budgetPaused, and a sufficient /set-budget clears it", async () => {
		await monitor.notifyCostPause(60, 52.5);
		const paused = (await (await fetch(`${base}/status`)).json()) as {
			budgetPaused: boolean;
		};
		expect(paused.budgetPaused).toBe(true);

		// No missionStats docs exist for this mission (no real spend recorded),
		// so any positive cap clears the pause once persisted.
		const res = await fetch(`${base}/set-budget`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ capUsd: 100 }),
		});
		expect(res.ok).toBe(true);

		const resumed = (await (await fetch(`${base}/status`)).json()) as {
			budgetPaused: boolean;
		};
		expect(resumed.budgetPaused).toBe(false);
	});
});
