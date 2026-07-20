/**
 * Cockpit Limits panel backend — GET/PATCH read+write against real MongoDB.
 * No LLM calls, no daemon. Calls readLimits/writeMissionCap/writeAgentLimits
 * directly (this repo has no supertest-equivalent HTTP-route test pattern —
 * see copilot-tools.integration.test.ts for the precedent this follows).
 */

import { randomUUID } from "node:crypto";
import { parseTeamConfig } from "@magi/agent-config";
import type { Db, MongoClient } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectMongo } from "../../agent-runtime-worker/src/mongo.js";
import {
	readLimits,
	writeAgentLimits,
	writeMissionCap,
} from "../src/missions.js";

const baseYaml = (extra = "") => `
mission:
  id: test-mission
  name: Test Mission
${extra}
agents:
  - id: analyst
    supervisor: user
    systemPrompt: You are a helpful agent.
    initialMentalMap: <section id="tasks"></section>
  - id: trader
    supervisor: user
    systemPrompt: You are a helpful agent.
    initialMentalMap: <section id="tasks"></section>
    limits:
      maxLlmCallsPerTurn: 10
`;

describe("Limits panel backend", () => {
	// biome-ignore lint/style/noNonNullAssertion: required env var; vitest.setup.ts validates presence
	const MONGODB_URI = process.env.MONGODB_URI!;

	let client: MongoClient;
	let db: Db;
	const userA = `user-a-${randomUUID()}`;
	const userB = `user-b-${randomUUID()}`;
	const missionId = `mission-limits-${randomUUID()}`;

	beforeEach(async () => {
		({ client, db } = await connectMongo(MONGODB_URI, "magi-test"));

		const now = new Date();
		await db.collection("missions").insertOne({
			missionId,
			userId: userA,
			name: "Test Mission",
			teamConfig: "",
			teamConfigYaml: baseYaml(),
			status: "running",
			privateIp: "::1", // unreachable in tests — exercises the best-effort-null path
			createdAt: now,
			updatedAt: now,
		});

		await db.collection("missionStats").insertMany([
			{
				missionId,
				agentId: "analyst",
				lifetimeCostUsd: 12.5,
				lifetimeLlmCallCount: 40,
				lifetimeTurnCount: 5,
				consecutiveZeroOutputTurns: 1,
			},
			{
				missionId,
				agentId: "trader",
				lifetimeCostUsd: 3.2,
				lifetimeLlmCallCount: 8,
				lifetimeTurnCount: 2,
				consecutiveZeroOutputTurns: 0,
			},
		]);

		await db.collection("agentTurnStats").insertOne({
			missionId,
			agentId: "analyst",
			turnNumber: 5,
			startedAt: now,
			completedAt: now,
			costUsd: 1.1,
			llmCallCount: 6,
			peakContextTokens: 42_000,
			toolErrors: { Bash: 2, WriteFile: 1 },
			status: "complete",
		});
	});

	afterEach(async () => {
		await db.collection("missions").deleteMany({ missionId });
		await db.collection("missionStats").deleteMany({ missionId });
		await db.collection("agentTurnStats").deleteMany({ missionId });
		await db.collection("mailbox").deleteMany({ missionId });
		await client.close();
	});

	const col = () => db.collection("missions");

	describe("readLimits", () => {
		it("populates effectiveSoft even for an agent with no limits: block", async () => {
			const result = await readLimits(col(), db, missionId, {
				userId: userA,
			});
			expect(result.status).toBe(200);
			const body = result.body as {
				agents: Array<{
					agentId: string;
					effectiveSoft: Record<string, number>;
				}>;
			};
			const analyst = body.agents.find((a) => a.agentId === "analyst");
			expect(analyst?.effectiveSoft).toEqual({
				warnLlmCallsPerTurn: 40,
				warnPeakContextTokens: 160_000,
				warnToolErrorsPerTurn: 8,
				warnConsecutiveZeroOutputTurns: 3,
			});
		});

		it("includes a mission-copilot row sourced from missionCopilotLimits, shaped like a normal agent row", async () => {
			const result = await readLimits(col(), db, missionId, {
				userId: userA,
			});
			const body = result.body as {
				agents: Array<{ agentId: string; limits: Record<string, unknown> }>;
			};
			const copilot = body.agents.find((a) => a.agentId === "mission-copilot");
			expect(copilot).toBeDefined();
			expect(copilot?.limits).toEqual({});
		});

		it("surfaces live lifetime and most-recent-turn numbers", async () => {
			const result = await readLimits(col(), db, missionId, {
				userId: userA,
			});
			const body = result.body as {
				agents: Array<{
					agentId: string;
					live: {
						lifetimeCostUsd: number | null;
						mostRecentTurn: { toolErrorsTotal: number } | null;
					};
				}>;
			};
			const analyst = body.agents.find((a) => a.agentId === "analyst");
			expect(analyst?.live.lifetimeCostUsd).toBe(12.5);
			expect(analyst?.live.mostRecentTurn?.toolErrorsTotal).toBe(3);
		});

		it("rejects a cross-user missionId", async () => {
			const result = await readLimits(col(), db, missionId, {
				userId: userB,
			});
			expect(result.status).toBe(404);
		});
	});

	describe("writeAgentLimits", () => {
		it("persists a valid patch, round-trip-parseable, teamFiles untouched", async () => {
			const before = await col().findOne({ missionId });
			expect(before?.teamFiles).toBeUndefined();

			const result = await writeAgentLimits(
				col(),
				db,
				missionId,
				{ userId: userA },
				"analyst",
				{ maxLifetimeCostUsd: 40 },
			);
			expect(result.status).toBe(200);

			const after = await col().findOne({ missionId });
			const config = parseTeamConfig(after?.teamConfigYaml as string);
			expect(config.agents.find((a) => a.id === "analyst")?.limits).toEqual({
				maxLifetimeCostUsd: 40,
			});
			expect(after?.teamFiles).toBeUndefined();
		});

		it("rejects an invalid limits object and writes nothing", async () => {
			const before = await col().findOne({ missionId });
			const result = await writeAgentLimits(
				col(),
				db,
				missionId,
				{ userId: userA },
				"analyst",
				{ maxLlmCallsPerTurn: -5 } as never,
			);
			expect(result.status).toBe(400);
			const after = await col().findOne({ missionId });
			expect(after?.teamConfigYaml).toBe(before?.teamConfigYaml);
		});

		it("targeting mission-copilot persists into missionCopilotLimits, not agents[]", async () => {
			const result = await writeAgentLimits(
				col(),
				db,
				missionId,
				{ userId: userA },
				"mission-copilot",
				{ maxLifetimeCostUsd: 15 },
			);
			expect(result.status).toBe(200);
			const after = await col().findOne({ missionId });
			const config = parseTeamConfig(after?.teamConfigYaml as string);
			expect(config.missionCopilotLimits).toEqual({ maxLifetimeCostUsd: 15 });
			expect(config.agents.some((a) => a.id === "mission-copilot")).toBe(false);
		});

		it("404s on an unknown agentId and writes nothing", async () => {
			const before = await col().findOne({ missionId });
			const result = await writeAgentLimits(
				col(),
				db,
				missionId,
				{ userId: userA },
				"nonexistent",
				{ maxLlmCallsPerTurn: 5 },
			);
			expect(result.status).toBe(404);
			const after = await col().findOne({ missionId });
			expect(after?.teamConfigYaml).toBe(before?.teamConfigYaml);
		});

		it("posts exactly one mailbox audit message", async () => {
			await writeAgentLimits(
				col(),
				db,
				missionId,
				{ userId: userA },
				"analyst",
				{ maxLlmCallsPerTurn: 5 },
			);
			const msgs = await db.collection("mailbox").find({ missionId }).toArray();
			expect(msgs).toHaveLength(1);
			expect(msgs[0].from).toBe("user");
			expect(msgs[0].to).toEqual(["mission-copilot"]);
			expect(msgs[0].subject).toContain("analyst");
		});
	});

	describe("writeMissionCap", () => {
		it("persists maxCostUsd into teamConfigYaml's mission node", async () => {
			const result = await writeMissionCap(
				col(),
				db,
				missionId,
				{ userId: userA },
				50,
			);
			expect(result.status).toBe(200);
			const after = await col().findOne({ missionId });
			const config = parseTeamConfig(after?.teamConfigYaml as string);
			expect(config.mission.maxCostUsd).toBe(50);
		});

		it("liveUpdateApplied is false when the monitor is unreachable, but the write still succeeds", async () => {
			const result = await writeMissionCap(
				col(),
				db,
				missionId,
				{ userId: userA },
				50,
			);
			const body = result.body as {
				ok: boolean;
				liveUpdateApplied: boolean;
			};
			expect(body.ok).toBe(true);
			expect(body.liveUpdateApplied).toBe(false);
		});

		it("rejects a non-positive cap", async () => {
			const result = await writeMissionCap(
				col(),
				db,
				missionId,
				{ userId: userA },
				0,
			);
			expect(result.status).toBe(400);
		});
	});
});
