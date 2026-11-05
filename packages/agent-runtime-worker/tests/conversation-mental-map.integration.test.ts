/**
 * #102 against real MongoDB: an agent whose turn counter once reset has an
 * older, compacted session under HIGHER turn numbers than its current one
 * (seen live on meteo-textbook's data-scientist and gold-digest-v2's analyst).
 * The current mental map is the newest snapshot, not the highest-numbered
 * one, and the next turn number continues above every number ever used.
 */

import { randomUUID } from "node:crypto";
import type { Db, MongoClient } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMongoConversationRepository } from "../src/conversation-repository.js";
import { connectMongo } from "../src/mongo.js";

describe("conversation repository after a turn-counter reset (#102)", () => {
	// biome-ignore lint/style/noNonNullAssertion: required env var; vitest.setup.ts validates presence
	const MONGODB_URI = process.env.MONGODB_URI!;
	let client: MongoClient;
	let db: Db;
	const missionId = `mental-map-102-${randomUUID()}`;
	const agentId = "data-scientist";
	const msg = { role: "assistant", content: [{ type: "text", text: "x" }] };

	beforeEach(async () => {
		({ client, db } = await connectMongo(MONGODB_URI, "magi-test"));
		const august = new Date("2026-08-17T18:00:00Z");
		const october = new Date("2026-10-27T23:00:00Z");
		await db.collection("conversationMessages").insertMany([
			// The August session, compacted, under turn numbers up to 54.
			{
				agentId,
				missionId,
				turnNumber: 53,
				seqInTurn: 0,
				savedAt: august,
				compacted: true,
				message: msg,
				mentalMapHtml: "<p>AUGUST 53</p>",
			},
			{
				agentId,
				missionId,
				turnNumber: 54,
				seqInTurn: 0,
				savedAt: august,
				compacted: true,
				message: msg,
				mentalMapHtml: "<p>AUGUST 54</p>",
			},
			// After the reset, the October session reused lower numbers.
			{
				agentId,
				missionId,
				turnNumber: 52,
				seqInTurn: 5,
				savedAt: october,
				message: msg,
				mentalMapHtml: "<p>OCTOBER RCE</p>",
			},
		]);
	});

	afterEach(async () => {
		await db.collection("conversationMessages").deleteMany({ missionId });
		await client.close();
	});

	it("returns the newest mental map, not the one under the highest turn number", async () => {
		const repo = createMongoConversationRepository(db);
		expect(await repo.loadMostRecentMentalMap(agentId, missionId)).toBe(
			"<p>OCTOBER RCE</p>",
		);
	});

	it("continues the turn counter above every number the agent ever used, compacted included", async () => {
		const repo = createMongoConversationRepository(db);
		expect(await repo.lastTurnNumber(agentId, missionId)).toBe(54);
		expect(await repo.lastTurnNumber("someone-else", missionId)).toBe(-1);
	});

	it("an edit saved in the next turn is the one loaded after it", async () => {
		const repo = createMongoConversationRepository(db);
		const next = (await repo.lastTurnNumber(agentId, missionId)) + 1;
		await repo.append(agentId, missionId, [
			{
				turnNumber: next,
				message: msg as never,
				mentalMapHtml: "<p>EDITED</p>",
			},
		]);
		expect(await repo.loadMostRecentMentalMap(agentId, missionId)).toBe(
			"<p>EDITED</p>",
		);
	});
});
