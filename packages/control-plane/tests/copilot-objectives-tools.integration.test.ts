/**
 * Control-plane copilot's ReviewObjectives/AssessKpi tools against real
 * MongoDB (ADR-0019). Previously zero coverage (confirmed via grep before
 * this migration — neither tool name appeared anywhere under tests/). Both
 * tools switched from monitorFetch/monitorPost (require a running mission,
 * mission.privateIp) to direct Mongo reads/writes — this is also the
 * regression test proving that decoupling: both work on a mission with no
 * privateIp at all (i.e. never provisioned / suspended).
 */

import { randomUUID } from "node:crypto";
import type { Db, MongoClient } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectMongo } from "../../agent-runtime-worker/src/mongo.js";
import {
	createCopilotTools,
	PendingActionsStore,
} from "../src/copilot-tools.js";

describe("copilot ReviewObjectives / AssessKpi — MongoDB-direct (ADR-0019)", () => {
	// biome-ignore lint/style/noNonNullAssertion: required env var; vitest.setup.ts validates presence
	const MONGODB_URI = process.env.MONGODB_URI!;

	let client: MongoClient;
	let db: Db;
	const userId = `user-${randomUUID()}`;
	const missionId = `copilot-obj-${randomUUID()}`;

	function tool(name: string) {
		const tools = createCopilotTools(
			db,
			() => {},
			new PendingActionsStore(),
			userId,
		);
		const t = tools.find((t) => t.name === name);
		if (!t) throw new Error(`tool ${name} not found`);
		return t;
	}

	beforeEach(async () => {
		({ client, db } = await connectMongo(MONGODB_URI, "magi-test"));
		const now = new Date();
		// No privateIp/machineId at all — this mission has never been
		// provisioned. Both tools must still work.
		await db.collection("missions").insertOne({
			missionId,
			userId,
			name: "Objectives Test Mission",
			teamConfig: "",
			status: "suspended",
			createdAt: now,
			updatedAt: now,
		});
		await db.collection("objectivesGoals").insertOne({
			missionId,
			objectives: [
				{
					id: "OBJ-1",
					parent: null,
					title: "root",
					owner: "analyst",
					status: "active",
					kpis: [
						{
							id: "K1",
							label: "coverage",
							owner: "analyst",
							kind: "qualitative",
							source: "copilot-assessment",
						},
					],
				},
			],
			updatedAt: now,
			updatedBy: "test",
		});
	});

	afterEach(async () => {
		await db.collection("missions").deleteMany({ missionId });
		await db.collection("objectivesGoals").deleteMany({ missionId });
		await db.collection("objectivesEvents").deleteMany({ missionId });
		await client.close();
	});

	it("ReviewObjectives reads the folded tree without requiring the mission to be running", async () => {
		const res = await tool("ReviewObjectives").execute("t1", { missionId });
		expect(res.isError).toBeFalsy();
		const tree = JSON.parse(res.content[0].text) as {
			objectives: Array<{ id: string }>;
		};
		expect(tree.objectives[0]?.id).toBe("OBJ-1");
	});

	it("ReviewObjectives 404s (as an error result) for a mission owned by another user", async () => {
		const otherUserTools = createCopilotTools(
			db,
			() => {},
			new PendingActionsStore(),
			`other-${randomUUID()}`,
		);
		const reviewObjectives = otherUserTools.find(
			(t) => t.name === "ReviewObjectives",
		);
		if (!reviewObjectives) throw new Error("tool not found");
		const res = await reviewObjectives.execute("t1", { missionId });
		expect(res.isError).toBe(true);
	});

	it("AssessKpi records a KPI value, visible on the next ReviewObjectives", async () => {
		const assessRes = await tool("AssessKpi").execute("t1", {
			missionId,
			kpi: "K1",
			value: "met",
			note: "looks complete",
		});
		expect(assessRes.isError).toBeFalsy();

		const events = await db
			.collection("objectivesEvents")
			.find({ missionId, kind: "kpi" })
			.toArray();
		expect(events).toHaveLength(1);
		expect(events[0].by).toBe("copilot");
		expect(events[0].value).toBe("met");

		const reviewRes = await tool("ReviewObjectives").execute("t1", {
			missionId,
		});
		const tree = JSON.parse(reviewRes.content[0].text) as {
			objectives: Array<{ kpis: Array<{ id: string; value: unknown }> }>;
		};
		expect(tree.objectives[0].kpis[0].value).toBe("met");
	});

	// github#29: the control-plane copilot had no way to write objectives into
	// the store at all — it fell back to a team file (goals.json), invisible to
	// the cockpit's Objectives panel, which only reads objectivesGoals.
	describe("SaveObjectiveTree", () => {
		it("replaces the objective tree, visible on the next ReviewObjectives", async () => {
			const res = await tool("SaveObjectiveTree").execute("t1", {
				missionId,
				objectives: [
					{
						id: "O1",
						parent: null,
						title: "New root objective",
						owner: "steward",
						status: "active",
						kpis: [],
					},
				],
			});
			expect(res.isError).toBeFalsy();

			const reviewRes = await tool("ReviewObjectives").execute("t1", {
				missionId,
			});
			const tree = JSON.parse(reviewRes.content[0].text) as {
				objectives: Array<{ id: string }>;
			};
			expect(tree.objectives).toHaveLength(1);
			expect(tree.objectives[0].id).toBe("O1");
		});

		it("rejects a malformed objective instead of writing it", async () => {
			const res = await tool("SaveObjectiveTree").execute("t1", {
				missionId,
				objectives: [{ id: "O1" /* missing required fields */ }],
			});
			expect(res.isError).toBe(true);

			// The original seeded objective (OBJ-1) must be untouched.
			const reviewRes = await tool("ReviewObjectives").execute("t1", {
				missionId,
			});
			const tree = JSON.parse(reviewRes.content[0].text) as {
				objectives: Array<{ id: string }>;
			};
			expect(tree.objectives[0].id).toBe("OBJ-1");
		});

		it("404s (as an error result) for a mission owned by another user", async () => {
			const otherUserTools = createCopilotTools(
				db,
				() => {},
				new PendingActionsStore(),
				`other-${randomUUID()}`,
			);
			const saveObjectiveTree = otherUserTools.find(
				(t) => t.name === "SaveObjectiveTree",
			);
			if (!saveObjectiveTree) throw new Error("tool not found");
			const res = await saveObjectiveTree.execute("t1", {
				missionId,
				objectives: [],
			});
			expect(res.isError).toBe(true);
		});
	});
});
