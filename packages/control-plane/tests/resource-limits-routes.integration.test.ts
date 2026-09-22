/**
 * ADR-0031 Decision 7 operator surfaces — GET /:id/limits's `upgrades` block,
 * PATCH /:id/limits/upgrade-reset, and GET /:id/machine-runtime — against
 * real MongoDB. No LLM, no daemon, no Fly.
 */

import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentConfig, TeamConfig } from "@magi/agent-config";
import express from "express";
import type { Db, MongoClient } from "mongodb";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { connectMongo } from "../../agent-runtime-worker/src/mongo.js";
import { createMissionResourceRoutes } from "../src/mission-resource-routes.js";
import { readLimits, writeUpgradedRuntimeReset } from "../src/missions.js";

function baseMission(): TeamConfig["mission"] {
	return { id: "test-mission", name: "Test Mission" };
}

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

describe("ADR-0031 operator surfaces", () => {
	// biome-ignore lint/style/noNonNullAssertion: required env var; vitest.setup.ts validates presence
	const MONGODB_URI = process.env.MONGODB_URI!;
	let client: MongoClient;
	let db: Db;
	const userA = `user-a-${randomUUID()}`;
	const userB = `user-b-${randomUUID()}`;
	const missionId = `mission-upgrade-limits-${randomUUID()}`;

	// One connection for the whole file: this Atlas cluster's connect time is
	// 10s+, and a per-test reconnect has flaked on a DNS/SRV lookup timeout
	// in other suites (see copilot-waker.integration.test.ts).
	beforeAll(async () => {
		({ client, db } = await connectMongo(MONGODB_URI, "magi-test"));
	}, 60_000);

	afterAll(async () => {
		await client.close();
	});

	afterEach(async () => {
		await db.collection("missions").deleteMany({ missionId });
		await db.collection("machineSegments").deleteMany({ missionId });
		await db.collection("mailbox").deleteMany({ missionId });
	});

	async function seedMission(over: Record<string, unknown> = {}) {
		const now = new Date();
		await db.collection("missions").insertOne({
			missionId,
			userId: userA,
			name: "Test Mission",
			teamConfig: "",
			mission: baseMission(),
			agents: baseAgents(),
			status: "suspended",
			createdAt: now,
			updatedAt: now,
			...over,
		});
	}

	function seg(over: Record<string, unknown>) {
		return {
			missionId,
			shape: { cpuKind: "shared", cpus: 1, memoryMb: 1024 },
			upgraded: false,
			...over,
		};
	}

	const col = () => db.collection("missions");

	describe("GET /:id/limits — upgrades block", () => {
		it("reports zero used, no reset, no active upgrade for a fresh mission", async () => {
			await seedMission();
			const result = await readLimits(col(), db, missionId, {
				userId: userA,
			});
			expect(result.status).toBe(200);
			const body = result.body as {
				upgrades: {
					usedHours: number;
					capHours: number;
					resetAt: string | null;
					active: unknown;
				};
			};
			expect(body.upgrades).toEqual({
				usedHours: 0,
				capHours: 24,
				resetAt: null,
				active: null,
			});
		});

		it("reports the active upgrade and its requester", async () => {
			const expiresAt = new Date(Date.now() + 30 * 60_000);
			await seedMission({
				upgrade: {
					cpuKind: "performance",
					cpus: 2,
					memoryMb: 8192,
					expiresAt,
					requestedByAgentId: "analyst",
				},
			});
			const result = await readLimits(col(), db, missionId, {
				userId: userA,
			});
			const body = result.body as {
				upgrades: { active: Record<string, unknown> | null };
			};
			expect(body.upgrades.active).toEqual({
				cpuKind: "performance",
				cpus: 2,
				memoryMb: 8192,
				expiresAt: expiresAt.toISOString(),
				requestedByAgentId: "analyst",
			});
		});

		it("sums upgraded runtime since the last reset, ignoring earlier segments", async () => {
			const now = Date.now();
			await seedMission({
				upgradedRuntimeResetAt: new Date(now - 5 * 3_600_000),
			});
			await db.collection("machineSegments").insertMany([
				seg({
					upgraded: true,
					startedAt: new Date(now - 20 * 3_600_000),
					endedAt: new Date(now - 15 * 3_600_000),
				}), // before the reset — excluded
				seg({
					upgraded: true,
					startedAt: new Date(now - 3 * 3_600_000),
					endedAt: new Date(now - 1 * 3_600_000),
				}), // 2h, after the reset — included
			]);
			const result = await readLimits(col(), db, missionId, {
				userId: userA,
			});
			const body = result.body as { upgrades: { usedHours: number } };
			expect(body.upgrades.usedHours).toBeCloseTo(2, 1);
		});

		it("404s a cross-user mission", async () => {
			await seedMission();
			const result = await readLimits(col(), db, missionId, {
				userId: userB,
			});
			expect(result.status).toBe(404);
		});
	});

	describe("writeUpgradedRuntimeReset", () => {
		it("sets the reset point, posts an audit message, and 200s with the timestamp", async () => {
			await seedMission();
			const before = Date.now();

			const result = await writeUpgradedRuntimeReset(col(), db, missionId, {
				userId: userA,
			});

			expect(result.status).toBe(200);
			const body = result.body as { ok: boolean; resetAt: string };
			expect(body.ok).toBe(true);
			expect(new Date(body.resetAt).getTime()).toBeGreaterThanOrEqual(before);

			const mission = await col().findOne({ missionId });
			expect(mission?.upgradedRuntimeResetAt?.toISOString()).toBe(body.resetAt);

			const audit = await db
				.collection("mailbox")
				.findOne({ missionId, subject: "Upgraded-runtime counter reset" });
			expect(audit).toMatchObject({
				from: "user",
				to: ["mission-copilot"],
			});
		});

		it("zeroes usedHours reported by GET /:id/limits without touching the segment history", async () => {
			const now = Date.now();
			await seedMission();
			await db.collection("machineSegments").insertOne(
				seg({
					upgraded: true,
					startedAt: new Date(now - 3 * 3_600_000),
					endedAt: new Date(now - 1 * 3_600_000),
				}),
			);

			const before = await readLimits(col(), db, missionId, {
				userId: userA,
			});
			expect(
				(before.body as { upgrades: { usedHours: number } }).upgrades.usedHours,
			).toBeCloseTo(2, 1);

			await writeUpgradedRuntimeReset(col(), db, missionId, {
				userId: userA,
			});

			const after = await readLimits(col(), db, missionId, {
				userId: userA,
			});
			expect(
				(after.body as { upgrades: { usedHours: number } }).upgrades.usedHours,
			).toBe(0);

			const segmentsStillThere = await db
				.collection("machineSegments")
				.countDocuments({ missionId });
			expect(segmentsStillThere).toBe(1);
		});

		it("404s a cross-user mission and does not write anything", async () => {
			await seedMission();
			const result = await writeUpgradedRuntimeReset(col(), db, missionId, {
				userId: userB,
			});
			expect(result.status).toBe(404);
			const mission = await col().findOne({ missionId });
			expect(mission?.upgradedRuntimeResetAt).toBeUndefined();
		});
	});

	describe("GET /:id/machine-runtime", () => {
		let server: Server;
		let base: string;

		beforeAll(async () => {
			const app = express();
			// Test-only stand-in for requireAuth: real auth is verified
			// elsewhere (auth.ts's own tests); this route only cares about
			// req.userId/req.isAdmin, which requireAuth sets identically
			// regardless of whether the caller used a Firebase JWT or the
			// admin API key.
			app.use((req, _res, next) => {
				req.userId = req.header("x-test-user") ?? "";
				req.isAdmin = req.header("x-test-admin") === "true";
				next();
			});
			app.use(createMissionResourceRoutes(db));
			await new Promise<void>((resolve) => {
				server = app.listen(0, "127.0.0.1", resolve);
			});
			base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		});

		afterAll(async () => {
			await new Promise((resolve) => server.close(resolve));
		});

		async function callRoute(userId: string) {
			const res = await fetch(`${base}/${missionId}/machine-runtime`, {
				headers: { "x-test-user": userId },
			});
			return { status: res.status, body: await res.json() };
		}

		it("groups runtime by machine config within each horizon", async () => {
			const now = Date.now();
			await seedMission();
			await db.collection("machineSegments").insertMany([
				seg({
					upgraded: false,
					startedAt: new Date(now - 2 * 3_600_000),
					endedAt: new Date(now - 1 * 3_600_000),
				}),
				seg({
					upgraded: true,
					shape: { cpuKind: "performance", cpus: 2, memoryMb: 8192 },
					startedAt: new Date(now - 1 * 3_600_000),
					endedAt: new Date(now),
				}),
			]);

			const { status, body } = await callRoute(userA);
			expect(status).toBe(200);
			const lifetime = (
				body as {
					byHorizon: Record<
						string,
						Array<{ shape: unknown; upgraded: boolean; ms: number }>
					>;
				}
			).byHorizon.lifetime;
			expect(lifetime).toHaveLength(2);
			expect(lifetime.find((r) => r.upgraded)?.shape).toEqual({
				cpuKind: "performance",
				cpus: 2,
				memoryMb: 8192,
			});
		});

		it("excludes runtime from before the horizon's window", async () => {
			const now = Date.now();
			await seedMission();
			await db.collection("machineSegments").insertOne(
				seg({
					upgraded: true,
					startedAt: new Date(now - 40 * 24 * 3_600_000),
					endedAt: new Date(now - 39 * 24 * 3_600_000),
				}),
			);

			const { body } = await callRoute(userA);
			const byHorizon = (body as { byHorizon: Record<string, unknown[]> })
				.byHorizon;
			expect(byHorizon["30d"]).toEqual([]);
			expect(byHorizon.lifetime).toHaveLength(1);
		});

		it("404s a cross-user mission", async () => {
			await seedMission();
			const { status } = await callRoute(userB);
			expect(status).toBe(404);
		});
	});
});
