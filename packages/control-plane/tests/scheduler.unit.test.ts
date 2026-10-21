/**
 * Scheduler delivery — attempt-cap/escalation unit tests (ADR-0020).
 *
 * No MongoDB, no Fly API calls. Mongo access faked with an in-memory
 * collection store; test docs never set `machineId`, so `deliver()` never
 * takes the machine-resume branch and fly-machines.js never needs mocking.
 */

import { describe, expect, it } from "vitest";
import { deliver } from "../src/scheduler.js";

interface ScheduledDoc {
	_id: string;
	missionId: string;
	to: string[];
	subject: string;
	body: string;
	deliverAt: Date;
	cron?: string;
	label?: string;
	kind?: "message" | "job";
	pendingFire?: { dueAt: Date; requestedAt: Date };
	status: "pending" | "delivered" | "cancelled" | "failed";
	deliveryAttempts?: number;
	claimedAt?: Date;
	deliveredAt?: Date;
}

function fakeDb(opts: {
	scheduled: ScheduledDoc[];
	failSubject?: string; // insertOne throws when doc.subject === this
	userId?: string;
}) {
	const scheduled = opts.scheduled;
	const mailboxInserts: Record<string, unknown>[] = [];
	const missions = [{ missionId: "m1", userId: opts.userId ?? "user1" }];

	const db = {
		collection(name: string) {
			if (name === "scheduled_messages") {
				return {
					async findOneAndUpdate(
						filter: { status: string; deliverAt: { $lte: Date } },
						update: { $set: Partial<ScheduledDoc> },
					) {
						const doc = scheduled.find(
							(d) =>
								d.status === filter.status &&
								d.deliverAt.getTime() <= filter.deliverAt.$lte.getTime(),
						);
						if (!doc) return null;
						Object.assign(doc, update.$set);
						return { ...doc };
					},
					async updateOne(
						filter: { _id: string },
						update: { $set: Partial<ScheduledDoc> },
					) {
						const doc = scheduled.find((d) => d._id === filter._id);
						if (doc) Object.assign(doc, update.$set);
						return { acknowledged: true };
					},
					async updateMany(
						filter: { status: string; claimedAt: { $lt: Date } },
						update: { $set: Partial<ScheduledDoc> },
					) {
						let n = 0;
						for (const d of scheduled) {
							if (
								d.status === filter.status &&
								d.claimedAt !== undefined &&
								d.claimedAt.getTime() < filter.claimedAt.$lt.getTime()
							) {
								Object.assign(d, update.$set);
								n++;
							}
						}
						return { matchedCount: n };
					},
				};
			}
			if (name === "mailbox") {
				return {
					async createIndex() {
						return "idx";
					},
					async insertOne(doc: Record<string, unknown>) {
						if (opts.failSubject && doc.subject === opts.failSubject) {
							throw new Error("simulated delivery failure");
						}
						mailboxInserts.push(doc);
						return { acknowledged: true };
					},
				};
			}
			if (name === "missions") {
				return {
					async findOne(filter: { missionId: string }) {
						return (
							missions.find((m) => m.missionId === filter.missionId) ?? null
						);
					},
				};
			}
			if (name === "missionAnomalies") {
				return {
					async createIndex() {
						return "ok";
					},
					async insertOne(doc: Record<string, unknown>) {
						mailboxInserts.push({ __anomaly: true, ...doc });
						return { acknowledged: true };
					},
				};
			}
			throw new Error(`fakeDb: unexpected collection ${name}`);
		},
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake, not a real Db
	} as any;

	return { db, scheduled, mailboxInserts };
}

// deliver() reads the real Date.now() internally, so test fixtures must be
// relative to it, not a fixed calendar date.
const PAST = new Date(Date.now() - 3_600_000);

describe("scheduler deliver()", () => {
	it("delivers a due message and marks it delivered", async () => {
		const { db, scheduled, mailboxInserts } = fakeDb({
			scheduled: [
				{
					_id: "1",
					missionId: "m1",
					to: ["analyst"],
					subject: "Daily brief",
					body: "go",
					deliverAt: PAST,
					status: "pending",
				},
			],
		});

		await deliver(db);

		expect(scheduled[0].status).toBe("delivered");
		expect(mailboxInserts).toHaveLength(1);
		expect(mailboxInserts[0].subject).toBe("Daily brief");
	});

	it("reopens to pending with an incremented attempt count on a failure under the cap", async () => {
		const { db, scheduled } = fakeDb({
			scheduled: [
				{
					_id: "1",
					missionId: "m1",
					to: ["analyst"],
					subject: "Daily brief",
					body: "go",
					deliverAt: PAST,
					status: "pending",
				},
			],
			failSubject: "Daily brief",
		});

		await deliver(db);

		expect(scheduled[0].status).toBe("pending");
		expect(scheduled[0].deliveryAttempts).toBe(1);
		// deliverAt must be pushed into the future — otherwise the while(true)
		// loop immediately re-claims this same still-due message and burns all
		// MAX_DELIVERY_ATTEMPTS within this single call instead of spacing
		// retries across real ticks.
		expect(scheduled[0].deliverAt.getTime()).toBeGreaterThan(PAST.getTime());
		expect(scheduled[0].deliverAt.getTime()).toBeGreaterThan(Date.now());
	});

	it("marks the message failed and records a scheduling-failure anomaly past MAX_DELIVERY_ATTEMPTS", async () => {
		const { db, scheduled, mailboxInserts } = fakeDb({
			scheduled: [
				{
					_id: "1",
					missionId: "m1",
					to: ["analyst"],
					subject: "Daily brief",
					body: "go",
					deliverAt: PAST,
					status: "pending",
					deliveryAttempts: 5, // already at the cap — this attempt is #6
				},
			],
			failSubject: "Daily brief",
		});

		await deliver(db);

		expect(scheduled[0].status).toBe("failed");
		// Not reopened to pending — no infinite retry.
		expect(scheduled[0].status).not.toBe("pending");

		const anomaly = mailboxInserts.find((d) => d.__anomaly);
		expect(anomaly).toBeDefined();
		expect(anomaly).toMatchObject({
			missionId: "m1",
			category: "scheduling-failure",
			severity: "hard",
		});
	});

	it("does not touch messages that are not yet due", async () => {
		const future = new Date(Date.now() + 3_600_000);
		const { db, scheduled } = fakeDb({
			scheduled: [
				{
					_id: "1",
					missionId: "m1",
					to: ["analyst"],
					subject: "Not yet",
					body: "go",
					deliverAt: future,
					status: "pending",
				},
			],
		});

		await deliver(db);

		expect(scheduled[0].status).toBe("pending");
		expect(scheduled[0].deliveryAttempts).toBeUndefined();
	});
});

describe("deliver() lease semantics (SCH1/SCH5)", () => {
	const past = new Date(Date.now() - 60_000);

	it("claims under a lease, delivers, then marks a one-off delivered", async () => {
		const { db, scheduled, mailboxInserts } = fakeDb({
			scheduled: [
				{
					_id: "s1",
					missionId: "m1",
					to: ["lead"],
					subject: "one-off",
					body: "b",
					deliverAt: past,
					status: "pending",
				},
			],
		});
		await deliver(db as never);
		expect(mailboxInserts).toHaveLength(1);
		expect(scheduled[0].status).toBe("delivered");
		expect(scheduled[0].deliveredAt).toBeInstanceOf(Date);
	});

	it("re-opens a lease abandoned by a dead tick and delivers it", async () => {
		const { db, scheduled, mailboxInserts } = fakeDb({
			scheduled: [
				{
					_id: "s2",
					missionId: "m1",
					to: ["lead"],
					subject: "abandoned",
					body: "b",
					deliverAt: past,
					status: "delivering",
					claimedAt: new Date(Date.now() - 10 * 60_000),
				},
				{
					_id: "s3",
					missionId: "m1",
					to: ["lead"],
					subject: "fresh claim",
					body: "b",
					deliverAt: past,
					status: "delivering",
					claimedAt: new Date(),
				},
			],
		});
		await deliver(db as never);
		expect(mailboxInserts.map((m) => m.subject)).toEqual(["abandoned"]);
		expect(scheduled[0].status).toBe("delivered");
		expect(scheduled[1].status).toBe("delivering");
	});

	it("does not run two deliveries at once", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const { db, mailboxInserts } = fakeDb({
			scheduled: [
				{
					_id: "s4",
					missionId: "m1",
					to: ["lead"],
					subject: "slow",
					body: "b",
					deliverAt: past,
					status: "pending",
				},
			],
		});
		const mailbox = db.collection("mailbox") as {
			insertOne: (d: unknown) => Promise<unknown>;
		};
		const realInsert = mailbox.insertOne.bind(mailbox);
		mailbox.insertOne = async (d: unknown) => {
			await gate;
			return realInsert(d);
		};
		const first = deliver(db as never);
		const second = deliver(db as never); // overlaps: returns immediately
		await second;
		expect(mailboxInserts).toHaveLength(0);
		release();
		await first;
		expect(mailboxInserts).toHaveLength(1);
	});
});

describe('deliver() for kind: "job" schedules (ADR-0033 §3)', () => {
	it("stamps pendingFire with the due time, posts no mail, and re-arms the cron", async () => {
		const { db, scheduled, mailboxInserts } = fakeDb({
			scheduled: [
				{
					_id: "j1",
					missionId: "m1",
					to: ["a1"],
					subject: "Scheduled job: nightly",
					body: "",
					label: "nightly",
					kind: "job",
					cron: "0 2 * * *",
					deliverAt: PAST,
					status: "pending",
				},
			],
		});

		await deliver(db);

		expect(mailboxInserts).toHaveLength(0);
		expect(scheduled[0].pendingFire?.dueAt).toEqual(PAST);
		expect(scheduled[0].pendingFire?.requestedAt).toBeInstanceOf(Date);
		expect(scheduled[0].status).toBe("pending");
		expect(scheduled[0].deliverAt.getTime()).toBeGreaterThan(Date.now());
	});

	it("overwrites an unclaimed stamp on the next occurrence (missed fires coalesce)", async () => {
		const older = new Date(PAST.getTime() - 86_400_000);
		const { db, scheduled } = fakeDb({
			scheduled: [
				{
					_id: "j1",
					missionId: "m1",
					to: ["a1"],
					subject: "Scheduled job: nightly",
					body: "",
					label: "nightly",
					kind: "job",
					cron: "0 2 * * *",
					deliverAt: PAST,
					status: "pending",
					pendingFire: { dueAt: older, requestedAt: older },
				},
			],
		});

		await deliver(db);

		expect(scheduled[0].pendingFire?.dueAt).toEqual(PAST);
	});

	it("still mails a document with no kind (every pre-existing writer)", async () => {
		const { db, mailboxInserts } = fakeDb({
			scheduled: [
				{
					_id: "m",
					missionId: "m1",
					to: ["a1"],
					subject: "hello",
					body: "x",
					deliverAt: PAST,
					status: "pending",
				},
			],
		});
		await deliver(db);
		expect(mailboxInserts).toHaveLength(1);
	});
});
