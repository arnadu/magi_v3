/**
 * missions.ts's router — POST /, PUT /:id/config, POST /:id/resume against
 * real MongoDB (ADR-0021). First-ever coverage of these three routes:
 * limits.integration.test.ts calls readLimits/writeMissionCap/writeAgentLimits
 * as bare functions, never through the router, and no other file touched
 * missions.ts's router at all before this.
 *
 * No real Fly API calls — LOCAL_EXECUTION=true routes provisioning through
 * fly-machines.ts's provisionLocal()/local-machineId branch, which only
 * writes to a temp directory and never calls out to Fly.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, TeamConfig } from "@magi/agent-config";
import express from "express";
import type { Db, MongoClient } from "mongodb";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { connectMongo } from "../../agent-runtime-worker/src/mongo.js";
import { createMissionsRouter } from "../src/missions.js";
import { loadTemplates } from "../src/templates.js";

const REPO_ROOT = join(
	new URL(".", import.meta.url).pathname,
	"..",
	"..",
	"..",
);

function baseAgents(): AgentConfig[] {
	return [
		{
			id: "analyst",
			name: "analyst",
			role: "analyst",
			supervisor: "user",
			systemPrompt: "You are a helpful agent.",
			initialMentalMap: '<section id="tasks"></section>',
		},
	];
}

describe("missions.ts router — POST /, PUT /:id/config, POST /:id/resume", () => {
	// biome-ignore lint/style/noNonNullAssertion: required env var; vitest.setup.ts validates presence
	const MONGODB_URI = process.env.MONGODB_URI!;
	const ORIGINAL_ENV = { ...process.env };

	let client: MongoClient;
	let db: Db;
	let server: Server;
	let baseUrl: string;
	let localMissionsDir: string;
	const userId = `user-${randomUUID()}`;
	const missionIds: string[] = [];

	beforeAll(async () => {
		({ client, db } = await connectMongo(MONGODB_URI, "magi-test"));
		loadTemplates(REPO_ROOT);

		localMissionsDir = mkdtempSync(join(tmpdir(), "magi-missions-test-"));
		process.env.LOCAL_EXECUTION = "true";
		process.env.LOCAL_MISSIONS_DIR = localMissionsDir;

		const app = express();
		app.use(express.json({ limit: "4mb" }));
		app.use((req, _res, next) => {
			req.userId = userId;
			req.isAdmin = false;
			next();
		});
		app.use("/api/missions", createMissionsRouter(db));

		await new Promise<void>((resolve) => {
			server = app.listen(0, "127.0.0.1", () => {
				const addr = server.address();
				const port = typeof addr === "object" && addr ? addr.port : 0;
				baseUrl = `http://127.0.0.1:${port}/api/missions`;
				resolve();
			});
		});
	});

	afterAll(async () => {
		server?.close();
		rmSync(localMissionsDir, { recursive: true, force: true });
		process.env = { ...ORIGINAL_ENV };
		await db
			.collection("missions")
			.deleteMany({ missionId: { $in: missionIds } });
		await db
			.collection("missionConfigRevisions")
			.deleteMany({ missionId: { $in: missionIds } });
		await client.close();
	});

	function newMissionId(): string {
		const id = `missions-router-test-${randomUUID()}`;
		missionIds.push(id);
		return id;
	}

	describe("POST / — inline structured config", () => {
		it("creates a mission and persists the structured fields", async () => {
			const missionId = newMissionId();
			const res = await fetch(baseUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					missionId,
					name: "Test Mission",
					teamConfig: "inline",
					mission: { name: "Test Mission" },
					agents: baseAgents(),
				}),
			});
			expect(res.status).toBe(201);
			const body = (await res.json()) as {
				status: string;
				mission: TeamConfig["mission"];
			};
			expect(body.status).toBe("running");
			expect(body.mission.id).toBe(missionId);

			const doc = await db.collection("missions").findOne({ missionId });
			expect(doc?.agents).toHaveLength(1);
			expect(doc?.mission.name).toBe("Test Mission");
			expect(doc?.machineId).toMatch(/^local-/);
		});

		it("404s when mission/agents are omitted and teamConfig isn't a known template", async () => {
			const missionId = newMissionId();
			const res = await fetch(baseUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					missionId,
					name: "Test Mission",
					teamConfig: "not-a-real-template",
				}),
			});
			expect(res.status).toBe(404);
			const doc = await db.collection("missions").findOne({ missionId });
			expect(doc).toBeNull();
		});

		it("409s when the missionId already exists", async () => {
			const missionId = newMissionId();
			const payload = {
				missionId,
				name: "Test Mission",
				teamConfig: "inline",
				mission: { name: "Test Mission" },
				agents: baseAgents(),
			};
			const first = await fetch(baseUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(first.status).toBe(201);

			const second = await fetch(baseUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(second.status).toBe(409);
		});
	});

	describe("PUT /:id/config + POST /:id/resume", () => {
		let missionId: string;

		beforeEach(async () => {
			missionId = newMissionId();
			const res = await fetch(baseUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					missionId,
					name: "Editable Mission",
					teamConfig: "inline",
					mission: { name: "Editable Mission" },
					agents: baseAgents(),
				}),
			});
			expect(res.status).toBe(201);
		});

		afterEach(async () => {
			await db.collection("mailbox").deleteMany({ missionId });
		});

		it("requires the mission to be suspended before editing", async () => {
			const res = await fetch(`${baseUrl}/${missionId}/config`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					mission: { name: "Renamed" },
					agents: baseAgents(),
				}),
			});
			expect(res.status).toBe(409);
		});

		it("edit lands after suspend → PUT → resume (the resume-time-overwrite landmine scenario)", async () => {
			const suspendRes = await fetch(`${baseUrl}/${missionId}/suspend`, {
				method: "POST",
			});
			expect(suspendRes.status).toBe(200);

			const putRes = await fetch(`${baseUrl}/${missionId}/config`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					mission: { name: "Renamed After Edit" },
					agents: baseAgents(),
					teamFiles: [],
				}),
			});
			expect(putRes.status).toBe(200);

			const afterPut = await db.collection("missions").findOne({ missionId });
			expect(afterPut?.mission.name).toBe("Renamed After Edit");

			const resumeRes = await fetch(`${baseUrl}/${missionId}/resume`, {
				method: "POST",
			});
			expect(resumeRes.status).toBe(200);

			// The literal landmine: resume must not silently revert the edit made
			// while suspended back to some earlier snapshot.
			const afterResume = await db
				.collection("missions")
				.findOne({ missionId });
			expect(afterResume?.mission.name).toBe("Renamed After Edit");
			expect(afterResume?.status).toBe("running");

			const revisions = await db
				.collection("missionConfigRevisions")
				.find({ missionId })
				.toArray();
			expect(revisions.length).toBeGreaterThanOrEqual(1);
		});

		it("409s on a duplicate/retried resume call instead of racing with itself", async () => {
			// The mission created in beforeEach is already "running" (POST /
			// provisions immediately) — resuming it without suspending first is
			// exactly the double-click/retry scenario the idempotency guard exists
			// for: a second resume call must not delete the machine the first one
			// (or the original creation) just stood up.
			const before = await db.collection("missions").findOne({ missionId });
			expect(before?.status).toBe("running");
			const machineIdBefore = before?.machineId;

			const resumeRes = await fetch(`${baseUrl}/${missionId}/resume`, {
				method: "POST",
			});
			expect(resumeRes.status).toBe(409);

			const after = await db.collection("missions").findOne({ missionId });
			expect(after?.status).toBe("running");
			expect(after?.machineId).toBe(machineIdBefore);
		});

		it("400s when mission or agents are missing from the PUT payload", async () => {
			await fetch(`${baseUrl}/${missionId}/suspend`, { method: "POST" });
			const res = await fetch(`${baseUrl}/${missionId}/config`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mission: { name: "x" } }),
			});
			expect(res.status).toBe(400);
		});
	});
});
