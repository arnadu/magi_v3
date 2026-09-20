/**
 * AnomalyRecorder — unit tests (ADR-0020). No MongoDB; Mongo access faked
 * with an in-memory collection store, matching the pattern established in
 * mission-copilot-tools.unit.test.ts.
 */

import { describe, expect, it } from "vitest";
import { createMongoAnomalyRecorder } from "../src/anomaly.js";
import type { MailboxMessage, MailboxRepository } from "../src/mailbox.js";

function fakeMailbox(): MailboxRepository & { posted: MailboxMessage[] } {
	const posted: MailboxMessage[] = [];
	return {
		posted,
		async post(msg) {
			const full: MailboxMessage = {
				...msg,
				id: String(posted.length),
				timestamp: new Date(),
				readBy: [],
			};
			posted.push(full);
			return full;
		},
		async listUnread() {
			return [];
		},
		async markRead() {},
		async hasUnread() {
			return false;
		},
		async list() {
			return [];
		},
		async get() {
			return null;
		},
	};
}

function fakeDb() {
	const inserted: Record<string, unknown>[] = [];
	const db = {
		collection() {
			return {
				async createIndex() {
					return "ok";
				},
				async insertOne(doc: Record<string, unknown>) {
					inserted.push(doc);
					return { acknowledged: true, insertedId: "x" };
				},
			};
		},
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake, not a real Db
	} as any;
	return { db, inserted };
}

describe("createMongoAnomalyRecorder", () => {
	it("persists the anomaly and notifies the mission copilot", async () => {
		const { db, inserted } = fakeDb();
		const missionMailbox = fakeMailbox();
		const recorder = createMongoAnomalyRecorder(
			db,
			missionMailbox,
			"mission-copilot",
		);

		await recorder.record({
			missionId: "m1",
			category: "agent-crash",
			severity: "hard",
			agentId: "analyst",
			message: "boom",
		});

		expect(inserted).toHaveLength(1);
		expect(inserted[0]).toMatchObject({
			missionId: "m1",
			category: "agent-crash",
			severity: "hard",
		});
		expect(inserted[0].createdAt).toBeInstanceOf(Date);

		expect(missionMailbox.posted).toHaveLength(1);
		expect(missionMailbox.posted[0].to).toEqual(["mission-copilot"]);
		expect(missionMailbox.posted[0].body).toBe("boom");
	});

	it("does not notify the mission copilot when none is present", async () => {
		const { db } = fakeDb();
		const missionMailbox = fakeMailbox();
		const recorder = createMongoAnomalyRecorder(db, missionMailbox, undefined);

		await recorder.record({
			missionId: "m1",
			category: "unclean-restart",
			severity: "soft",
			message: "restarted",
		});

		expect(missionMailbox.posted).toHaveLength(0);
	});

	it("relays hard-severity anomalies to the control-plane copilot", async () => {
		const { db } = fakeDb();
		const missionMailbox = fakeMailbox();
		const copilotMailbox = fakeMailbox();
		const recorder = createMongoAnomalyRecorder(
			db,
			missionMailbox,
			"mission-copilot",
			{ mailboxRepo: copilotMailbox, missionId: "copilot-user1" },
		);

		await recorder.record({
			missionId: "m1",
			category: "agent-crash",
			severity: "hard",
			message: "boom",
		});

		expect(copilotMailbox.posted).toHaveLength(1);
		expect(copilotMailbox.posted[0].missionId).toBe("copilot-user1");
		expect(copilotMailbox.posted[0].to).toEqual(["copilot"]);
		expect(copilotMailbox.posted[0].body).toContain("m1");
	});

	it("does not relay soft-severity anomalies to the control-plane copilot", async () => {
		const { db } = fakeDb();
		const missionMailbox = fakeMailbox();
		const copilotMailbox = fakeMailbox();
		const recorder = createMongoAnomalyRecorder(
			db,
			missionMailbox,
			"mission-copilot",
			{ mailboxRepo: copilotMailbox, missionId: "copilot-user1" },
		);

		await recorder.record({
			missionId: "m1",
			category: "limit-breach",
			severity: "soft",
			message: "warn",
		});

		expect(copilotMailbox.posted).toHaveLength(0);
	});

	it("never throws when the mailbox posts fail", async () => {
		const { db } = fakeDb();
		const failingMailbox: MailboxRepository = {
			post: async () => {
				throw new Error("mongo down");
			},
			listUnread: async () => [],
			markRead: async () => {},
			hasUnread: async () => false,
			list: async () => [],
			get: async () => null,
		};
		const recorder = createMongoAnomalyRecorder(
			db,
			failingMailbox,
			"mission-copilot",
			{ mailboxRepo: failingMailbox, missionId: "copilot-user1" },
		);

		await expect(
			recorder.record({
				missionId: "m1",
				category: "agent-crash",
				severity: "hard",
				message: "boom",
			}),
		).resolves.toBeUndefined();
	});

	describe("resource-oversight categories (ADR-0032)", () => {
		const resourceCategories = [
			"disk-usage-high",
			"spend-cap-near",
			"spend-spike",
			"upgrade-cap-near",
			"upgrade-cap-reached",
			"upgrade-idle",
			"resize-failure",
			"oom-suspected",
		] as const;

		it.each(
			resourceCategories,
		)("%s soft: persisted and sent to the mission copilot, not relayed to the control-plane copilot", async (category) => {
			const { db, inserted } = fakeDb();
			const missionMailbox = fakeMailbox();
			const copilotMailbox = fakeMailbox();
			const recorder = createMongoAnomalyRecorder(
				db,
				missionMailbox,
				"mission-copilot",
				{ mailboxRepo: copilotMailbox, missionId: "copilot-user1" },
			);

			await recorder.record({
				missionId: "m1",
				category,
				severity: "soft",
				message: "heads up",
			});

			expect(inserted[0]).toMatchObject({ category, severity: "soft" });
			expect(missionMailbox.posted).toHaveLength(1);
			expect(copilotMailbox.posted).toHaveLength(0);
		});

		it.each(
			resourceCategories,
		)("%s hard: relayed to the control-plane copilot naming the category and mission", async (category) => {
			const { db } = fakeDb();
			const copilotMailbox = fakeMailbox();
			const recorder = createMongoAnomalyRecorder(
				db,
				fakeMailbox(),
				"mission-copilot",
				{ mailboxRepo: copilotMailbox, missionId: "copilot-user1" },
			);

			await recorder.record({
				missionId: "m1",
				category,
				severity: "hard",
				message: "act now",
			});

			expect(copilotMailbox.posted).toHaveLength(1);
			expect(copilotMailbox.posted[0].subject).toContain(category);
			expect(copilotMailbox.posted[0].subject).toContain("m1");
		});
	});
});
