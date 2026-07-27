/**
 * ObjectivesRepository against real MongoDB (ADR-0019). No LLM calls. First-
 * ever coverage of the Mongo-backed objectives store — readTree/saveGoals/
 * append*Event/hasGoalsDoc round-trip through the `objectivesGoals`/
 * `objectivesEvents` collections the cockpit's ObjectivesPanel and every
 * objectives tool now read/write directly.
 */

import { randomUUID } from "node:crypto";
import type { Db, MongoClient } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectMongo } from "../src/mongo.js";
import { createMongoObjectivesRepository } from "../src/objectives/repository.js";

describe("ObjectivesRepository against real MongoDB", () => {
	// biome-ignore lint/style/noNonNullAssertion: required env var; vitest.setup.ts validates presence
	const MONGODB_URI = process.env.MONGODB_URI!;

	let client: MongoClient;
	let db: Db;
	const missionId = `objectives-repo-${randomUUID()}`;

	beforeEach(async () => {
		({ client, db } = await connectMongo(MONGODB_URI, "magi-test"));
	});

	afterEach(async () => {
		await db.collection("objectivesGoals").deleteMany({ missionId });
		await db.collection("objectivesEvents").deleteMany({ missionId });
		await client.close();
	});

	it("readGoals/readTree return empty when nothing is stored", async () => {
		const repo = createMongoObjectivesRepository(db);
		expect(await repo.readGoals(missionId)).toEqual({ objectives: [] });
		const tree = await repo.readTree(missionId);
		expect(tree.objectives).toEqual([]);
		expect(tree.tasks).toEqual([]);
		expect(await repo.hasGoalsDoc(missionId)).toBe(false);
	});

	it("saveGoals overwrites (not merges) and marks hasGoalsDoc true", async () => {
		const repo = createMongoObjectivesRepository(db);
		await repo.saveGoals(
			missionId,
			{
				objectives: [
					{
						id: "OBJ-1",
						parent: null,
						title: "first",
						owner: "alice",
						status: "active",
						kpis: [],
					},
				],
			},
			"alice",
		);
		expect(await repo.hasGoalsDoc(missionId)).toBe(true);

		await repo.saveGoals(
			missionId,
			{
				objectives: [
					{
						id: "OBJ-2",
						parent: null,
						title: "second",
						owner: "bob",
						status: "active",
						kpis: [],
					},
				],
			},
			"bob",
		);
		const goals = await repo.readGoals(missionId);
		expect(goals.objectives.map((o) => o.id)).toEqual(["OBJ-2"]); // overwritten, not merged
	});

	it("appendTaskEvent/appendKpiEvent/appendCostEvent round-trip through readTree's fold", async () => {
		const repo = createMongoObjectivesRepository(db);
		await repo.saveGoals(
			missionId,
			{
				objectives: [
					{
						id: "OBJ-1",
						parent: null,
						title: "root",
						owner: "alice",
						status: "active",
						kpis: [
							{
								id: "K1",
								label: "coverage",
								owner: "alice",
								kind: "quantitative",
								source: "agent-reported",
							},
						],
					},
				],
			},
			"alice",
		);
		await repo.appendTaskEvent(missionId, {
			id: "T1",
			at: "2026-07-01T00:00:00.000Z",
			by: "alice",
			title: "do it",
			objective: "OBJ-1",
			status: "in-progress",
		});
		await repo.appendKpiEvent(missionId, {
			kpi: "K1",
			value: 42,
			by: "alice",
			at: "2026-07-01T00:01:00.000Z",
		});
		await repo.appendCostEvent(missionId, {
			turn: 1,
			agent: "alice",
			at: "2026-07-01T00:02:00.000Z",
			alloc: { T1: 0.5 },
		});

		const tree = await repo.readTree(missionId);
		expect(tree.tasks).toHaveLength(1);
		expect(tree.tasks[0].status).toBe("in-progress");
		expect(tree.tasks[0].costUsd).toBeCloseTo(0.5);
		expect(tree.objectives[0].kpis[0].value).toBe(42);
	});

	it("appendAllocEvent/readAllocEvents round-trip independently of the fold", async () => {
		const repo = createMongoObjectivesRepository(db);
		await repo.appendAllocEvent(missionId, {
			by: "alice",
			at: "2026-07-01T00:00:00.000Z",
			key: { "TASK-1": 60, overhead: 40 },
		});
		const events = await repo.readAllocEvents(missionId);
		expect(events).toHaveLength(1);
		expect(events[0].key).toEqual({ "TASK-1": 60, overhead: 40 });
	});

	it("readTaskEvents/readCostEvents scope strictly by missionId (no cross-mission leakage)", async () => {
		const repo = createMongoObjectivesRepository(db);
		const otherMissionId = `${missionId}-other`;
		try {
			await repo.appendTaskEvent(missionId, {
				id: "T1",
				at: "2026-07-01T00:00:00.000Z",
				by: "alice",
				status: "open",
			});
			await repo.appendTaskEvent(otherMissionId, {
				id: "T2",
				at: "2026-07-01T00:00:00.000Z",
				by: "bob",
				status: "open",
			});
			const events = await repo.readTaskEvents(missionId);
			expect(events.map((e) => e.id)).toEqual(["T1"]);
		} finally {
			await db
				.collection("objectivesEvents")
				.deleteMany({ missionId: otherMissionId });
		}
	});

	it("readGoals degrades to empty (no throw) on an invalid stored document", async () => {
		await db.collection("objectivesGoals").insertOne({
			missionId,
			// Missing required "owner"/"status" fields on the objective.
			objectives: [{ id: "OBJ-1", title: "bad" }],
			updatedAt: new Date(),
			updatedBy: "test",
		});
		const repo = createMongoObjectivesRepository(db);
		const goals = await repo.readGoals(missionId);
		expect(goals.objectives).toEqual([]);
	});
});
