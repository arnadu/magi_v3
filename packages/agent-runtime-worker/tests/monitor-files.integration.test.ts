/**
 * Sprint 25 Slice C/D — Integration test for the monitor upload + download
 * endpoints. Spins up a real MonitorServer (Mongo-backed mailbox) on a free port
 * and drives /upload and /download over HTTP. No LLM: a text upload and no
 * visionModel means processing is fully deterministic.
 *
 * Requires MONGODB_URI. (No pool users / API key needed.)
 */

import { execFileSync } from "node:child_process";
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
import { dirname, join } from "node:path";
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
import { WorkspaceGit } from "../src/workspace-git.js";

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
	mkdirSync(sharedDir, { recursive: true });
	execFileSync("git", ["-C", sharedDir, "init", "-q"]);
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

describe("POST /files/shared/edit", () => {
	it("saves content, commits immediately (not deferred to a turn), and notifies the last-touching agent", async () => {
		// Seed a file "as" a prior agent turn: write it, commit it directly
		// through WorkspaceGit, then record that commit against an agentTurnStats
		// doc — the same join resolveFileHistory() performs for real turns.
		const relPath = "notes/plan.md";
		const absPath = join(sharedDir, relPath);
		mkdirSync(dirname(absPath), { recursive: true });
		writeFileSync(absPath, "# Original\n");
		const seedGit = new WorkspaceGit(sharedDir);
		const seedCommit = await seedGit.commit("seed");
		expect(seedCommit).not.toBeNull();
		await client.db("magi-test").collection("agentTurnStats").insertOne({
			missionId,
			agentId: "echo",
			turnNumber: 3,
			gitCommit: seedCommit?.commit,
		});

		const res = await fetch(`${base}/files/shared/edit`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				path: relPath,
				content: "# Edited by operator\n",
			}),
		});
		expect(res.ok).toBe(true);
		const json = (await res.json()) as { ok: boolean; commit: string | null };
		expect(json.ok).toBe(true);
		expect(json.commit).not.toBeNull();
		expect(json.commit).not.toBe(seedCommit?.commit);

		// Content actually changed on disk, immediately — not queued for a
		// future turn's commit.
		expect(readFileSync(absPath, "utf8")).toBe("# Edited by operator\n");

		// The commit is real and separately attributed (no matching
		// agentTurnStats entry — this is the "outside edit" case).
		const log = execFileSync("git", [
			"-C",
			sharedDir,
			"log",
			"-1",
			"--format=%s",
			json.commit as string,
		]).toString();
		expect(log.trim()).toBe(`operator edit: ${relPath}`);

		// The most-recent prior toucher (echo, from the seed commit) was notified.
		const notif = await client
			.db("magi-test")
			.collection("mailbox")
			.findOne({ missionId, to: "echo", subject: { $regex: relPath } });
		expect(notif).toBeTruthy();
		expect(notif?.from).toBe("user");
	});

	it("rejects path traversal", async () => {
		const res = await fetch(`${base}/files/shared/edit`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "../../etc/passwd", content: "x" }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects a disallowed (non-text) extension", async () => {
		const res = await fetch(`${base}/files/shared/edit`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				path: "diagram.png",
				content: "not really png bytes",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("rejects content over the 10 MB edit limit", async () => {
		// Just over the 10 MB content cap, but comfortably under the raw
		// request-body cap (readBody's own overflow guard destroys the socket
		// rather than returning a clean response — that's a different, lower-level
		// protection; this test is for handleFileEdit's own size check).
		const big = "a".repeat(10 * 1024 * 1024 + 1);
		const res = await fetch(`${base}/files/shared/edit`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "big.txt", content: big }),
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error: string };
		expect(json.error).toContain("MB edit limit");
	});
});
