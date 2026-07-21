/**
 * ADR-0018 — MissionConfigRepository against real MongoDB. No LLM calls.
 * Verifies readTeamConfig/writeMissionCap read/write the same teamConfigYaml
 * field the cockpit's Limits panel (control-plane's missions.ts) uses, so an
 * edit from either side is visible to the other with no restart.
 */

import { randomUUID } from "node:crypto";
import type { Db, MongoClient } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMongoMissionConfigRepository } from "../src/mission-config.js";
import { connectMongo } from "../src/mongo.js";

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
    limits:
      maxLlmCallsPerTurn: 10
`;

describe("MissionConfigRepository against real MongoDB", () => {
	// biome-ignore lint/style/noNonNullAssertion: required env var; vitest.setup.ts validates presence
	const MONGODB_URI = process.env.MONGODB_URI!;

	let client: MongoClient;
	let db: Db;
	const missionId = `mission-config-${randomUUID()}`;

	beforeEach(async () => {
		({ client, db } = await connectMongo(MONGODB_URI, "magi-test"));
	});

	afterEach(async () => {
		await db.collection("missions").deleteMany({ missionId });
		await client.close();
	});

	it("returns null when no mission doc exists", async () => {
		const repo = createMongoMissionConfigRepository(db);
		expect(await repo.readTeamConfig(missionId)).toBeNull();
	});

	it("returns null (and logs) when teamConfigYaml fails to parse", async () => {
		await db.collection("missions").insertOne({
			missionId,
			teamConfigYaml: "not: [valid, team, config",
		});
		const repo = createMongoMissionConfigRepository(db);
		expect(await repo.readTeamConfig(missionId)).toBeNull();
	});

	it("reads the agent's current limits fresh — reflects an edit made by another writer", async () => {
		await db.collection("missions").insertOne({
			missionId,
			teamConfigYaml: baseYaml(),
		});
		const repo = createMongoMissionConfigRepository(db);

		const first = await repo.readTeamConfig(missionId);
		expect(first?.agents[0]?.limits?.maxLlmCallsPerTurn).toBe(10);

		// Simulate a second writer (the cockpit's control-plane route) editing
		// teamConfigYaml directly — no coordination with this repo instance.
		await db.collection("missions").updateOne(
			{ missionId },
			{
				$set: {
					teamConfigYaml: baseYaml().replace(
						"maxLlmCallsPerTurn: 10",
						"maxLlmCallsPerTurn: 25",
					),
				},
			},
		);

		const second = await repo.readTeamConfig(missionId);
		expect(second?.agents[0]?.limits?.maxLlmCallsPerTurn).toBe(25);
	});

	it("writeMissionCap patches and persists mission.maxCostUsd", async () => {
		await db.collection("missions").insertOne({
			missionId,
			teamConfigYaml: baseYaml(),
		});
		const repo = createMongoMissionConfigRepository(db);

		await repo.writeMissionCap(missionId, 42.5);

		const live = await repo.readTeamConfig(missionId);
		expect(live?.mission.maxCostUsd).toBeCloseTo(42.5, 8);
	});

	it("writeMissionCap throws when no mission doc exists, without writing anything", async () => {
		const repo = createMongoMissionConfigRepository(db);
		await expect(repo.writeMissionCap(missionId, 10)).rejects.toThrow();
		expect(await db.collection("missions").findOne({ missionId })).toBeNull();
	});

	it("writeMissionCap validates before persisting — invalid resulting config is rejected", async () => {
		// A mission block with no agents[] fails parseTeamConfig's schema —
		// patchMissionCap only edits the mission.maxCostUsd field, so this
		// exercises the post-patch parseTeamConfig() validation step.
		await db.collection("missions").insertOne({
			missionId,
			teamConfigYaml: "mission:\n  id: test-mission\n  name: Test Mission\n",
		});
		const repo = createMongoMissionConfigRepository(db);
		await expect(repo.writeMissionCap(missionId, 10)).rejects.toThrow();
	});
});
