/**
 * executeAction's schedule branches (EA1/EA2): ownership goes through the
 * mission, a cancel that matched nothing is a failure, a bare cron is first
 * delivered at its next occurrence rather than now, and a failure is thrown
 * (so /confirm reports ok:false) instead of being returned as a string.
 */

import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { executeAction } from "../src/copilot-router.js";
import type { PendingAction } from "../src/pending-actions.js";

interface Sched {
	_id: ObjectId;
	missionId: string;
	status: string;
}

function fakeDb(opts: {
	missions: Array<{
		missionId: string;
		userId: string;
		agents?: Array<{ id: string }>;
	}>;
	schedules?: Sched[];
}) {
	const schedules = opts.schedules ?? [];
	const inserted: Record<string, unknown>[] = [];
	const updates: Array<{ filter: Record<string, unknown>; set: unknown }> = [];
	const db = {
		collection(name: string) {
			if (name === "missions") {
				return {
					findOne: async (f: { missionId: string; userId?: string }) =>
						opts.missions.find(
							(m) =>
								m.missionId === f.missionId &&
								(f.userId === undefined || m.userId === f.userId),
						) ?? null,
				};
			}
			if (name === "scheduled_messages") {
				return {
					findOne: async (f: { _id: ObjectId }) =>
						schedules.find((s) => s._id.equals(f._id)) ?? null,
					updateOne: async (
						f: { _id: ObjectId; status?: string },
						u: { $set: unknown },
					) => {
						updates.push({ filter: f, set: u.$set });
						const hit = schedules.find(
							(s) =>
								s._id.equals(f._id) &&
								(f.status === undefined || s.status === f.status),
						);
						if (hit) hit.status = "cancelled";
						return { matchedCount: hit ? 1 : 0 };
					},
					insertOne: async (doc: Record<string, unknown>) => {
						inserted.push(doc);
						return { insertedId: new ObjectId() };
					},
				};
			}
			throw new Error(`unexpected collection ${name}`);
		},
	};
	return { db: db as never, inserted, updates };
}

function action(
	type: string,
	payload: unknown,
	userId = "owner",
): PendingAction {
	return { id: "a1", userId, type, label: "", payload, createdAt: new Date() };
}

describe("executeAction: create_schedule", () => {
	it("refuses a mission the user does not own", async () => {
		const { db, inserted } = fakeDb({
			missions: [{ missionId: "m1", userId: "someone-else" }],
		});
		await expect(
			executeAction(
				db,
				action("create_schedule", {
					missionId: "m1",
					to: ["lead"],
					subject: "s",
					body: "b",
					cron: "0 9 * * 1",
				}),
				"owner",
			),
		).rejects.toThrow(/not found/);
		expect(inserted).toHaveLength(0);
	});

	it("refuses a recipient that is not on the mission's roster", async () => {
		const { db } = fakeDb({
			missions: [
				{ missionId: "m1", userId: "owner", agents: [{ id: "lead" }] },
			],
		});
		await expect(
			executeAction(
				db,
				action("create_schedule", {
					missionId: "m1",
					to: ["lead", "ghost"],
					subject: "s",
					body: "b",
					cron: "0 9 * * 1",
				}),
				"owner",
			),
		).rejects.toThrow(/unknown recipient\(s\) ghost/);
	});

	it("inserts with the first delivery at the cron's next occurrence, not now", async () => {
		const { db, inserted } = fakeDb({
			missions: [
				{ missionId: "m1", userId: "owner", agents: [{ id: "lead" }] },
			],
		});
		const before = Date.now();
		const result = await executeAction(
			db,
			action("create_schedule", {
				missionId: "m1",
				to: ["lead", "user"],
				subject: "s",
				body: "b",
				cron: "0 9 * * 1",
			}),
			"owner",
		);
		expect(inserted).toHaveLength(1);
		const doc = inserted[0] as {
			deliverAt: Date;
			status: string;
			createdBy: string;
		};
		expect(doc.status).toBe("pending");
		expect(doc.createdBy).toBe("owner");
		expect(doc.deliverAt.getTime()).toBeGreaterThan(before + 60_000);
		expect(result).toMatch(/first delivery .*then cron 0 9 \* \* 1/);
	});

	it("rejects a malformed stored payload at execution time too", async () => {
		const { db } = fakeDb({ missions: [{ missionId: "m1", userId: "owner" }] });
		await expect(
			executeAction(
				db,
				action("create_schedule", { missionId: "m1" }),
				"owner",
			),
		).rejects.toThrow(/Invalid payload for create_schedule/);
	});
});

describe("executeAction: cancel_schedule", () => {
	const sid = new ObjectId();

	it("refuses to cancel another user's schedule and reports it as not found", async () => {
		const { db, updates } = fakeDb({
			missions: [{ missionId: "m1", userId: "someone-else" }],
			schedules: [{ _id: sid, missionId: "m1", status: "pending" }],
		});
		await expect(
			executeAction(
				db,
				action("cancel_schedule", { id: sid.toHexString() }),
				"owner",
			),
		).rejects.toThrow(/not found/);
		expect(updates).toHaveLength(0);
	});

	it("fails instead of claiming success when nothing was pending", async () => {
		const { db } = fakeDb({
			missions: [{ missionId: "m1", userId: "owner" }],
			schedules: [{ _id: sid, missionId: "m1", status: "delivered" }],
		});
		await expect(
			executeAction(
				db,
				action("cancel_schedule", { id: sid.toHexString() }),
				"owner",
			),
		).rejects.toThrow(/already delivered/);
	});

	it("cancels an owned, pending schedule as an operator cancel, so ingest does not re-import its file", async () => {
		const { db, updates } = fakeDb({
			missions: [{ missionId: "m1", userId: "owner" }],
			schedules: [{ _id: sid, missionId: "m1", status: "pending" }],
		});
		await expect(
			executeAction(
				db,
				action("cancel_schedule", { id: sid.toHexString() }),
				"owner",
			),
		).resolves.toMatch(/cancelled/);
		expect(updates[0].set).toMatchObject({
			status: "cancelled",
			cancelledBy: "operator",
		});
	});
});
