/**
 * mission-config-revisions.ts — the shared structured-config write helper
 * (ADR-0021), against real MongoDB. No LLM calls.
 */

import { randomUUID } from "node:crypto";
import type { AgentConfig, TeamConfig } from "@magi/agent-config";
import type { Db, MongoClient } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMongoMissionConfigWriter } from "../src/mission-config-revisions.js";
import { connectMongo } from "../src/mongo.js";

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

describe("createMongoMissionConfigWriter against real MongoDB", () => {
	// biome-ignore lint/style/noNonNullAssertion: required env var; vitest.setup.ts validates presence
	const MONGODB_URI = process.env.MONGODB_URI!;

	let client: MongoClient;
	let db: Db;
	const missionId = `mission-config-revisions-${randomUUID()}`;

	beforeEach(async () => {
		({ client, db } = await connectMongo(MONGODB_URI, "magi-test"));
		await db.collection("missions").insertOne({
			missionId,
			mission: { id: missionId, name: "Initial" },
			agents: baseAgents(),
			status: "suspended",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
	});

	afterEach(async () => {
		await db.collection("missions").deleteMany({ missionId });
		await db.collection("missionConfigRevisions").deleteMany({ missionId });
		await client.close();
	});

	it("$sets the missions doc's structured fields", async () => {
		const writer = createMongoMissionConfigWriter(db);
		const nextMission: TeamConfig["mission"] = {
			id: missionId,
			name: "Renamed",
		};
		await writer.write(
			missionId,
			{ mission: nextMission, agents: baseAgents() },
			"user",
		);

		const doc = await db.collection("missions").findOne({ missionId });
		expect(doc?.mission).toEqual(nextMission);
		expect(doc?.updatedAt).toBeInstanceOf(Date);
	});

	it("appends exactly one missionConfigRevisions doc per write, in order", async () => {
		const writer = createMongoMissionConfigWriter(db);
		await writer.write(
			missionId,
			{ mission: { id: missionId, name: "V1" }, agents: baseAgents() },
			"user",
		);
		await writer.write(
			missionId,
			{ mission: { id: missionId, name: "V2" }, agents: baseAgents() },
			"mission-copilot",
		);

		const revisions = await db
			.collection("missionConfigRevisions")
			.find({ missionId })
			.sort({ at: 1 })
			.toArray();
		expect(revisions).toHaveLength(2);
		expect(revisions[0].by).toBe("user");
		expect(revisions[0].mission.name).toBe("V1");
		expect(revisions[1].by).toBe("mission-copilot");
		expect(revisions[1].mission.name).toBe("V2");
	});

	it("each revision stores only the post-write snapshot, not a before/after pair", async () => {
		const writer = createMongoMissionConfigWriter(db);
		await writer.write(
			missionId,
			{ mission: { id: missionId, name: "V1" }, agents: baseAgents() },
			"user",
		);

		const [revision] = await db
			.collection("missionConfigRevisions")
			.find({ missionId })
			.toArray();
		expect(revision).not.toHaveProperty("before");
		expect(revision).not.toHaveProperty("after");
		expect(revision.mission.name).toBe("V1");
	});

	it("omitting missionCopilotLimits from the snapshot clears it (undefined, not preserved)", async () => {
		await db
			.collection("missions")
			.updateOne(
				{ missionId },
				{ $set: { missionCopilotLimits: { maxLifetimeCostUsd: 5 } } },
			);

		const writer = createMongoMissionConfigWriter(db);
		await writer.write(
			missionId,
			{ mission: { id: missionId, name: "V1" }, agents: baseAgents() },
			"user",
		);

		const doc = await db.collection("missions").findOne({ missionId });
		expect(doc?.missionCopilotLimits).toBeUndefined();
	});
});
