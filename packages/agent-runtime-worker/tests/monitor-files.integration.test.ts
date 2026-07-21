/**
 * Sprint 25 Slice C/D — Integration test for the monitor upload + download
 * endpoints. Spins up a real MonitorServer (Mongo-backed mailbox) on a free port
 * and drives /upload and /download over HTTP. No LLM: a text upload and no
 * visionModel means processing is fully deterministic.
 *
 * Requires MONGODB_URI. (No pool users / API key needed.)
 */

import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
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

const missionId = `monitor-files-${randomUUID()}`;
let client: Awaited<ReturnType<typeof connectMongo>>["client"];
let monitor: MonitorServer;
let workdir: string;
let sharedDir: string;
let base: string;

beforeAll(async () => {
	workdir = mkdtempSync(join(tmpdir(), "magi-monfiles-"));
	sharedDir = join(workdir, "shared");
	const conn = await connectMongo(MONGODB_URI, "magi-test");
	client = conn.client;
	const mailboxRepo = createMongoMailboxRepository(conn.db, missionId);
	const agents: AgentInfo[] = [{ id: "echo", name: "Echo", role: "assistant" }];
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
		sharedDir,
		undefined,
		workdir, // publicDir (unused here)
	);
	await monitor.start(port);
	base = `http://127.0.0.1:${port}`;
}, 60_000);

afterAll(async () => {
	monitor?.stop();
	await client?.db("magi-test").collection("mailbox").deleteMany({ missionId });
	await client?.close();
	if (workdir) rmSync(workdir, { recursive: true, force: true });
});

describe("monitor /upload + /download", () => {
	let artifactId: string;

	it("processes an upload into an artifact and posts a mailbox message", async () => {
		const text = "hello world\n".repeat(10);
		const res = await fetch(`${base}/upload`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				filename: "notes.txt",
				agentId: "echo",
				subject: "Please review",
				body: "Have a look at this.",
				contentBase64: Buffer.from(text).toString("base64"),
			}),
		});
		expect(res.ok).toBe(true);
		const json = (await res.json()) as { artifactId: string; format: string };
		expect(json.format).toBe("text");
		artifactId = json.artifactId;

		// Processed artifact exists; full text preserved.
		const md = await readFile(
			join(sharedDir, "artifacts", artifactId, "content.md"),
			"utf8",
		);
		expect(md.match(/hello world/g)?.length).toBe(10);

		// Pristine original saved under uploads/<date>/.
		const dateDir = new Date().toISOString().slice(0, 10);
		expect(
			readFileSync(join(sharedDir, "uploads", dateDir, "notes.txt"), "utf8"),
		).toBe(text);

		// Mailbox message to the agent references the artifact + operator note.
		const repo = createMongoMailboxRepository(
			client.db("magi-test"),
			missionId,
		);
		const unread = await repo.listUnread("echo");
		expect(unread.length).toBeGreaterThanOrEqual(1);
		const msg = unread.find((m) => m.body.includes(artifactId));
		expect(
			msg,
			"expected a mailbox message referencing the artifact",
		).toBeTruthy();
		expect(msg?.body).toContain("Have a look at this.");
		expect(msg?.from).toBe("user");
	});

	it("rejects an upload for an unknown agent", async () => {
		const res = await fetch(`${base}/upload`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				filename: "x.txt",
				agentId: "nobody",
				contentBase64: Buffer.from("x").toString("base64"),
			}),
		});
		expect(res.status).toBe(404);
	});

	it("downloads a single file as an attachment", async () => {
		const res = await fetch(
			`${base}/download?path=${encodeURIComponent(`artifacts/${artifactId}/content.md`)}`,
		);
		expect(res.ok).toBe(true);
		expect(res.headers.get("content-disposition")).toContain("attachment");
		expect(await res.text()).toContain("hello world");
	});

	it("downloads a folder subtree as a zip", async () => {
		const res = await fetch(`${base}/download?path=&format=zip`);
		expect(res.ok).toBe(true);
		expect(res.headers.get("content-type")).toBe("application/zip");
		const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
		const names = Object.keys(zip.files);
		expect(
			names.some((n) => n.includes(`artifacts/${artifactId}/content.md`)),
		).toBe(true);
	});

	it("rejects path traversal outside sharedDir", async () => {
		const res = await fetch(
			`${base}/download?path=${encodeURIComponent("../../etc/passwd")}`,
		);
		expect(res.status).toBe(400);
	});
});

describe("monitor /objectives", () => {
	beforeAll(() => {
		// Author a goals.json with one objective + a reported KPI to receive a value.
		mkdirSync(join(sharedDir, "objectives"), { recursive: true });
		writeFileSync(
			join(sharedDir, "objectives", "goals.json"),
			JSON.stringify({
				objectives: [
					{
						id: "OBJ-1",
						parent: null,
						title: "root",
						owner: "echo",
						status: "active",
						kpis: [
							{
								id: "K1",
								label: "coverage",
								owner: "echo",
								kind: "qualitative",
								source: "copilot-assessment",
							},
						],
					},
				],
			}),
		);
	});

	it("records a KPI value via POST and reflects it in GET (folded)", async () => {
		const post = await fetch(`${base}/objectives/kpi`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				kpi: "K1",
				value: "partial",
				note: "2 of 5 names",
			}),
		});
		expect(post.ok).toBe(true);

		const get = await fetch(`${base}/objectives`);
		expect(get.ok).toBe(true);
		const tree = (await get.json()) as {
			objectives: {
				id: string;
				kpis: { id: string; value: unknown; updatedBy?: string }[];
			}[];
		};
		const kpi = tree.objectives[0].kpis.find((k) => k.id === "K1");
		expect(kpi?.value).toBe("partial");
		expect(kpi?.updatedBy).toBe("copilot"); // default author
	});

	it("rejects a KPI event missing kpi/value with 400", async () => {
		const res = await fetch(`${base}/objectives/kpi`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ value: "x" }),
		});
		expect(res.status).toBe(400);
	});
});
