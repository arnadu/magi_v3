/**
 * ConversationRepository.append() — unit tests for the duplicate-key retry
 * added for issue #37. No MongoDB; Mongo access faked with an in-memory
 * collection store, matching the pattern established in anomaly.unit.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
	createMongoConversationRepository,
	type StoredMessage,
} from "../src/conversation-repository.js";

function duplicateKeyError(): Error & { code: number } {
	const err = new Error("E11000 duplicate key error") as Error & {
		code: number;
	};
	err.code = 11000;
	return err;
}

function fakeDb(opts: { failFirstNInserts?: number } = {}) {
	const inserted: Record<string, unknown>[] = [];
	let insertAttempts = 0;
	const failFirstNInserts = opts.failFirstNInserts ?? 0;
	const db = {
		collection() {
			return {
				async createIndex() {
					return "ok";
				},
				async countDocuments() {
					return inserted.length;
				},
				async insertOne(doc: Record<string, unknown>) {
					insertAttempts++;
					if (insertAttempts <= failFirstNInserts) {
						throw duplicateKeyError();
					}
					inserted.push(doc);
					return { acknowledged: true, insertedId: String(inserted.length) };
				},
			};
		},
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake, not a real Db
	} as any;
	return { db, inserted, attempts: () => insertAttempts };
}

const message: StoredMessage = {
	turnNumber: 101,
	message: { role: "user", content: "hi" } as StoredMessage["message"],
};

describe("createMongoConversationRepository — append() duplicate-key retry", () => {
	it("inserts normally when there is no conflict", async () => {
		const { db, inserted } = fakeDb();
		const repo = createMongoConversationRepository(db);

		await repo.append("pedagogue", "mission-1", [message]);

		expect(inserted).toHaveLength(1);
		expect(inserted[0]?.seqInTurn).toBe(0);
	});

	it("retries with a recomputed seqInTurn on a duplicate-key error", async () => {
		const { db, inserted, attempts } = fakeDb({ failFirstNInserts: 2 });
		const repo = createMongoConversationRepository(db);

		await repo.append("pedagogue", "mission-1", [message]);

		expect(attempts()).toBe(3);
		expect(inserted).toHaveLength(1);
	});

	it("gives up and rethrows after exhausting retry attempts", async () => {
		const { db } = fakeDb({ failFirstNInserts: 10 });
		const repo = createMongoConversationRepository(db);

		await expect(
			repo.append("pedagogue", "mission-1", [message]),
		).rejects.toMatchObject({ code: 11000 });
	});

	it("does not retry and rethrows immediately on a non-duplicate-key error", async () => {
		const { db } = fakeDb();
		const otherError = new Error("connection reset");
		db.collection = () => ({
			async createIndex() {
				return "ok";
			},
			async countDocuments() {
				return 0;
			},
			async insertOne() {
				throw otherError;
			},
		});
		const repo = createMongoConversationRepository(db);

		await expect(
			repo.append("pedagogue", "mission-1", [message]),
		).rejects.toThrow("connection reset");
	});
});
