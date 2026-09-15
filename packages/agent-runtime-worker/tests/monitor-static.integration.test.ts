/**
 * Static asset routes (`/`, `/index.html`, `/style.css`, `/app.js`) —
 * characterization test written as part of the Sprint 28c route-table
 * extraction (issue #32). `/` is already exercised indirectly by
 * `dashboard.integration.test.ts`'s real page load; `/style.css`/`/app.js`
 * had no direct test before this.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const PUBLIC_DIR = join(REPO_ROOT, "packages/agent-runtime-worker/public");

function freePort(): Promise<number> {
	return new Promise((res) => {
		const s = createServer();
		s.listen(0, () => {
			const { port } = s.address() as { port: number };
			s.close(() => res(port));
		});
	});
}

const missionId = `monitor-static-${randomUUID()}`;
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
			name: "Static Assets Test",
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
		new Date(),
		process.cwd(),
		process.cwd(),
		undefined,
		PUBLIC_DIR,
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

describe("static assets", () => {
	it("GET /style.css returns the file on disk with the right Content-Type", async () => {
		const res = await fetch(`${base}/style.css`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/css");
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = await res.text();
		expect(body).toBe(readFileSync(join(PUBLIC_DIR, "style.css"), "utf8"));
	});

	it("GET /app.js returns the file on disk with the right Content-Type", async () => {
		const res = await fetch(`${base}/app.js`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/javascript");
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = await res.text();
		expect(body).toBe(readFileSync(join(PUBLIC_DIR, "app.js"), "utf8"));
	});

	it("GET / returns index.html with the right Content-Type", async () => {
		const res = await fetch(`${base}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
		const body = await res.text();
		expect(body).toBe(readFileSync(join(PUBLIC_DIR, "index.html"), "utf8"));
	});

	it("GET /index.html is equivalent to GET /", async () => {
		const res = await fetch(`${base}/index.html`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toBe(readFileSync(join(PUBLIC_DIR, "index.html"), "utf8"));
	});
});
