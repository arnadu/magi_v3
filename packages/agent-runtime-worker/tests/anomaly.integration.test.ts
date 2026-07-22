/**
 * ADR-0020 — AnomalyRecorder against real MongoDB. No LLM calls. Verifies
 * missionAnomalies persistence and, most importantly, that a hard-severity
 * anomaly relays to the correct per-user control-plane copilot mailbox
 * (copilot-{userId}) and does NOT leak into a different user's mailbox —
 * the actual correctness property this ADR exists to guarantee, replacing a
 * previously-dead, would-have-been-cross-user-leaking global "copilot"
 * mailbox.
 */

import { randomUUID } from "node:crypto";
import type { Db, MongoClient } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMongoAnomalyRecorder } from "../src/anomaly.js";
import { createMongoMailboxRepository } from "../src/mailbox.js";
import { connectMongo } from "../src/mongo.js";

describe("AnomalyRecorder against real MongoDB", () => {
	// biome-ignore lint/style/noNonNullAssertion: required env var; vitest.setup.ts validates presence
	const MONGODB_URI = process.env.MONGODB_URI!;

	let client: MongoClient;
	let db: Db;
	const missionId = `anomaly-test-${randomUUID()}`;
	const userA = `userA-${randomUUID()}`;
	const userB = `userB-${randomUUID()}`;

	beforeEach(async () => {
		({ client, db } = await connectMongo(MONGODB_URI, "magi-test"));
	});

	afterEach(async () => {
		await db.collection("missionAnomalies").deleteMany({ missionId });
		await db.collection("mailbox").deleteMany({
			missionId: { $in: [missionId, `copilot-${userA}`, `copilot-${userB}`] },
		});
		await client.close();
	});

	it("persists the anomaly to missionAnomalies", async () => {
		const mailboxRepo = createMongoMailboxRepository(db, missionId);
		const recorder = createMongoAnomalyRecorder(db, mailboxRepo, undefined);

		await recorder.record({
			missionId,
			category: "agent-crash",
			severity: "hard",
			agentId: "analyst",
			message: "boom",
		});

		const docs = await db
			.collection("missionAnomalies")
			.find({ missionId })
			.toArray();
		expect(docs).toHaveLength(1);
		expect(docs[0]).toMatchObject({
			missionId,
			category: "agent-crash",
			severity: "hard",
			agentId: "analyst",
		});
	});

	it("notifies the mission copilot's own mailbox", async () => {
		const mailboxRepo = createMongoMailboxRepository(db, missionId);
		const recorder = createMongoAnomalyRecorder(
			db,
			mailboxRepo,
			"mission-copilot",
		);

		await recorder.record({
			missionId,
			category: "limit-breach",
			severity: "soft",
			message: "warn",
		});

		const unread = await mailboxRepo.listUnread("mission-copilot");
		expect(unread).toHaveLength(1);
		expect(unread[0].body).toBe("warn");
	});

	it("relays a hard anomaly to the owning user's copilot mailbox, and not to a different user's", async () => {
		const mailboxRepo = createMongoMailboxRepository(db, missionId);
		const copilotAMailbox = createMongoMailboxRepository(
			db,
			`copilot-${userA}`,
		);
		const copilotBMailbox = createMongoMailboxRepository(
			db,
			`copilot-${userB}`,
		);
		const recorder = createMongoAnomalyRecorder(db, mailboxRepo, undefined, {
			mailboxRepo: copilotAMailbox,
			missionId: `copilot-${userA}`,
		});

		await recorder.record({
			missionId,
			category: "agent-crash",
			severity: "hard",
			agentId: "analyst",
			message: "boom",
		});

		const unreadA = await copilotAMailbox.listUnread("copilot");
		expect(unreadA).toHaveLength(1);
		expect(unreadA[0].body).toContain(missionId);

		// The point of this test: user B's copilot mailbox — a different
		// pseudo-mission entirely — must never see user A's mission's anomaly.
		const unreadB = await copilotBMailbox.listUnread("copilot");
		expect(unreadB).toHaveLength(0);
	});

	it("does not relay a soft anomaly to the control-plane copilot at all", async () => {
		const mailboxRepo = createMongoMailboxRepository(db, missionId);
		const copilotAMailbox = createMongoMailboxRepository(
			db,
			`copilot-${userA}`,
		);
		const recorder = createMongoAnomalyRecorder(db, mailboxRepo, undefined, {
			mailboxRepo: copilotAMailbox,
			missionId: `copilot-${userA}`,
		});

		await recorder.record({
			missionId,
			category: "llm-error",
			severity: "soft",
			message: "transient",
		});

		const unreadA = await copilotAMailbox.listUnread("copilot");
		expect(unreadA).toHaveLength(0);
	});
});
