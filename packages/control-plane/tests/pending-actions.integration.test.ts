/**
 * MongoPendingActionsStore (CP1): proposals survive a process restart (they
 * are documents, not a Map), `take` claims atomically so a double confirm
 * executes once, and a user only sees their own cards.
 *
 * Requires MONGODB_URI.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectMongo } from "../src/mongo.js";
import {
	MongoPendingActionsStore,
	PENDING_ACTIONS_COLLECTION,
	type PendingAction,
} from "../src/pending-actions.js";

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) throw new Error("MONGODB_URI is required");

const userA = `pa-user-a-${randomUUID()}`;
const userB = `pa-user-b-${randomUUID()}`;
let client: Awaited<ReturnType<typeof connectMongo>>["client"];
let db: Awaited<ReturnType<typeof connectMongo>>["db"];

function action(userId: string, id = randomUUID()): PendingAction {
	return {
		id,
		userId,
		type: "suspend_mission",
		label: `Suspend mission "m-${id.slice(0, 4)}"`,
		payload: { missionId: `m-${id.slice(0, 4)}` },
		createdAt: new Date(),
	};
}

beforeAll(async () => {
	({ client, db } = await connectMongo(MONGODB_URI, "magi-test"));
});

afterAll(async () => {
	await db
		.collection(PENDING_ACTIONS_COLLECTION)
		.deleteMany({ userId: { $in: [userA, userB] } });
	await client.close();
});

describe("MongoPendingActionsStore", () => {
	it("persists across store instances and lists per user", async () => {
		const s1 = new MongoPendingActionsStore(db);
		await s1.ensureIndexes();
		const a1 = action(userA);
		const a2 = action(userA);
		const b1 = action(userB);
		await s1.add(a1);
		await s1.add(a2);
		await s1.add(b1);

		// A "restart": a fresh instance over the same collection.
		const s2 = new MongoPendingActionsStore(db);
		expect(await s2.get(a1.id)).toMatchObject({
			id: a1.id,
			userId: userA,
			label: a1.label,
		});
		const listed = await s2.listForUser(userA);
		expect(listed.map((a) => a.id).sort()).toEqual([a1.id, a2.id].sort());
		expect(await s2.listForUser(userB)).toHaveLength(1);
	});

	it("take() hands the action to exactly one of two concurrent claimers", async () => {
		const s = new MongoPendingActionsStore(db);
		const a = action(userA);
		await s.add(a);
		const [x, y] = await Promise.all([s.take(a.id), s.take(a.id)]);
		expect([x, y].filter(Boolean)).toHaveLength(1);
		expect(await s.get(a.id)).toBeUndefined();
	});

	it("has a TTL index on createdAt", async () => {
		const s = new MongoPendingActionsStore(db);
		await s.ensureIndexes();
		const indexes = await db.collection(PENDING_ACTIONS_COLLECTION).indexes();
		const ttl = indexes.find(
			(i) => i.key.createdAt === 1 && i.expireAfterSeconds,
		);
		expect(ttl?.expireAfterSeconds).toBe(7 * 24 * 3600);
	});
});
