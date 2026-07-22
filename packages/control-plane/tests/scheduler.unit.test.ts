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
	status: "pending" | "delivered" | "cancelled" | "failed";
	deliveryAttempts?: number;
}

function fakeDb(opts: {
	scheduled: ScheduledDoc[];
	failSubject?: string; // insertOne throws when doc.subject === this
	userId?: string;
}) {
	const scheduled = opts.scheduled;
	const mailboxInserts: Record<string, unknown>[] = [];
	const missions = [
		{ missionId: "m1", userId: opts.userId ?? "user1", teamConfigYaml: "" },
	];

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
				};
			}
			if (name === "mailbox") {
				return {
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
