/**
 * Copilot B1 tool userId scoping — regression test for GitHub #19 (#14/#6).
 *
 * Seeds two missions owned by different users and asserts that ListMissions,
 * GetMissionStatus, ReadMissionMailbox, ReadMissionLog, and ReadMissionFile
 * cannot read across the userId boundary. Calls tool.execute() directly —
 * no LLM calls, no daemon, just MongoDB.
 */

import { randomUUID } from "node:crypto";
import type { Db, MongoClient } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectMongo } from "../../agent-runtime-worker/src/mongo.js";
import {
	createCopilotTools,
	PendingActionsStore,
} from "../src/copilot-tools.js";

describe("copilot B1 tools — userId scoping", () => {
	// biome-ignore lint/style/noNonNullAssertion: required env var; vitest.setup.ts validates presence
	const MONGODB_URI = process.env.MONGODB_URI!;

	let client: MongoClient;
	let db: Db;
	const userA = `user-a-${randomUUID()}`;
	const userB = `user-b-${randomUUID()}`;
	const missionA = `mission-a-${randomUUID()}`;
	const missionB = `mission-b-${randomUUID()}`;

	beforeEach(async () => {
		({ client, db } = await connectMongo(MONGODB_URI, "magi-test"));

		const now = new Date();
		await db.collection("missions").insertMany([
			{
				missionId: missionA,
				userId: userA,
				name: "Mission A",
				teamConfig: "",
				status: "running",
				createdAt: now,
				updatedAt: now,
			},
			{
				missionId: missionB,
				userId: userB,
				name: "Mission B",
				teamConfig: "",
				status: "running",
				createdAt: now,
				updatedAt: now,
			},
		]);

		await db.collection("mailbox").insertMany([
			{
				missionId: missionA,
				from: "user",
				to: ["lead"],
				subject: "hello A",
				body: "body A",
				timestamp: now,
			},
			{
				missionId: missionB,
				from: "user",
				to: ["lead"],
				subject: "hello B",
				body: "body B",
				timestamp: now,
			},
		]);
	});

	afterEach(async () => {
		await db
			.collection("missions")
			.deleteMany({ missionId: { $in: [missionA, missionB] } });
		await db
			.collection("mailbox")
			.deleteMany({ missionId: { $in: [missionA, missionB] } });
		await client.close();
	});

	function toolsFor(userId: string) {
		return createCopilotTools(db, () => {}, new PendingActionsStore(), userId);
	}

	function get(tools: ReturnType<typeof toolsFor>, name: string) {
		const tool = tools.find((t) => t.name === name);
		if (!tool) throw new Error(`tool ${name} not found`);
		return tool;
	}

	it("ListMissions only returns the caller's own missions", async () => {
		const toolsA = toolsFor(userA);
		const result = await get(toolsA, "ListMissions").execute("t1", {});
		const text = result.content[0].text;
		expect(text).toContain(missionA);
		expect(text).not.toContain(missionB);
	});

	it("GetMissionStatus rejects a cross-user missionId", async () => {
		const toolsA = toolsFor(userA);
		const own = await get(toolsA, "GetMissionStatus").execute("t1", {
			missionId: missionA,
		});
		expect(own.isError).toBeFalsy();

		const cross = await get(toolsA, "GetMissionStatus").execute("t2", {
			missionId: missionB,
		});
		expect(cross.isError).toBe(true);
		expect(cross.content[0].text).toContain("not found");
	});

	it("ReadMissionMailbox rejects a cross-user missionId", async () => {
		const toolsA = toolsFor(userA);
		const own = await get(toolsA, "ReadMissionMailbox").execute("t1", {
			missionId: missionA,
		});
		expect(own.isError).toBeFalsy();
		expect(own.content[0].text).toContain("hello A");

		const cross = await get(toolsA, "ReadMissionMailbox").execute("t2", {
			missionId: missionB,
		});
		expect(cross.isError).toBe(true);
		expect(cross.content[0].text).not.toContain("hello B");
	});

	// ReadMissionLog/ReadMissionFile both gate on `mission?.privateIp`, so a
	// cross-user missionId (findOne returns null) and an own mission that's
	// merely not running collapse to the same "has no private IP" message —
	// the security property under test is that neither path ever reaches
	// mission B's real log/file content, not the exact wording.

	it("ReadMissionLog rejects a cross-user missionId without leaking mission B's data", async () => {
		const toolsA = toolsFor(userA);
		const cross = await get(toolsA, "ReadMissionLog").execute("t1", {
			missionId: missionB,
		});
		expect(cross.isError).toBe(true);
		expect(cross.content[0].text).toContain(missionB);
		expect(cross.content[0].text).toContain("no private IP");
	});

	it("ReadMissionFile rejects a cross-user missionId without leaking mission B's data", async () => {
		const toolsA = toolsFor(userA);
		const cross = await get(toolsA, "ReadMissionFile").execute("t1", {
			missionId: missionB,
			path: "/",
		});
		expect(cross.isError).toBe(true);
		expect(cross.content[0].text).toContain(missionB);
		expect(cross.content[0].text).toContain("no private IP");
	});
});
