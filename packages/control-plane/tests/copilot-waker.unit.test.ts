/**
 * Copilot waker — unit tests (ADR-0032 Decision 1).
 *
 * No MongoDB: the mailbox collection is faked with a controllable change
 * stream and a canned aggregation result.
 */

import { EventEmitter } from "node:events";
import type { Db } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	startCopilotWaker,
	userIdFromCopilotMissionId,
	wakeStrandedCopilots,
} from "../src/copilot-waker.js";

class FakeStream extends EventEmitter {
	closed = false;
	constructor(readonly pipeline: unknown[]) {
		super();
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}

function fakeDb(opts: { strandedMissionIds?: () => unknown[] } = {}) {
	const streams: FakeStream[] = [];
	const aggregates: unknown[][] = [];
	const db = {
		collection(name: string) {
			expect(name).toBe("mailbox");
			return {
				watch(pipeline: unknown[]) {
					const s = new FakeStream(pipeline);
					streams.push(s);
					return s;
				},
				aggregate(pipeline: unknown[]) {
					aggregates.push(pipeline);
					return {
						async toArray() {
							return (opts.strandedMissionIds?.() ?? []).map((id) => ({
								_id: id,
							}));
						},
					};
				},
			};
		},
	} as unknown as Db;
	return { db, streams, aggregates };
}

describe("userIdFromCopilotMissionId", () => {
	it.each([
		["copilot-u1", "u1"],
		["copilot-firebase-uid-9", "firebase-uid-9"],
		["copilot-admin", "admin"],
		["copilot-", null],
		["copilot", null],
		["gold-digest-v2", null],
		["mission-copilot-x", null],
		[undefined, null],
		[42, null],
		[null, null],
	])("%j → %j", (input, expected) => {
		expect(userIdFromCopilotMissionId(input)).toBe(expected);
	});
});

describe("wakeStrandedCopilots", () => {
	afterEach(() => vi.restoreAllMocks());

	it("wakes each user with unread copilot mail and ignores other ids", async () => {
		const { db, aggregates } = fakeDb({
			strandedMissionIds: () => ["copilot-u1", "copilot-u2", "m1", "copilot-"],
		});
		const ensure = vi.fn().mockResolvedValue(undefined);

		const users = await wakeStrandedCopilots(db, ensure);

		expect(users).toBe(2);
		expect(ensure.mock.calls.map((c) => c[0])).toEqual(["u1", "u2"]);
		// Unread means: addressed to the copilot and not yet read by it.
		expect(aggregates[0][0]).toEqual({
			$match: {
				missionId: { $regex: "^copilot-" },
				to: "copilot",
				readBy: { $ne: "copilot" },
			},
		});
	});

	it("keeps waking the remaining users when one start fails", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const { db } = fakeDb({
			strandedMissionIds: () => ["copilot-u1", "copilot-u2"],
		});
		const ensure = vi.fn(async (userId: string) => {
			if (userId === "u1") throw new Error("boom");
		});

		const users = await wakeStrandedCopilots(db, ensure);

		expect(users).toBe(2);
		expect(ensure).toHaveBeenCalledTimes(2);
		expect(err).toHaveBeenCalledWith(expect.stringContaining('userId: "u1"'));
	});

	it("does nothing when there is no unread copilot mail", async () => {
		const { db } = fakeDb();
		const ensure = vi.fn();
		expect(await wakeStrandedCopilots(db, ensure)).toBe(0);
		expect(ensure).not.toHaveBeenCalled();
	});
});

describe("startCopilotWaker", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("watches inserts addressed to any copilot mailbox", () => {
		const { db, streams } = fakeDb();
		const stop = startCopilotWaker(db, vi.fn());
		expect(streams).toHaveLength(1);
		expect(streams[0].pipeline).toEqual([
			{
				$match: {
					operationType: "insert",
					"fullDocument.missionId": { $regex: "^copilot-" },
					"fullDocument.to": "copilot",
				},
			},
		]);
		stop();
	});

	it("starts the copilot of the user whose mailbox received mail", () => {
		const { db, streams } = fakeDb();
		const ensure = vi.fn().mockResolvedValue(undefined);
		const stop = startCopilotWaker(db, ensure);

		streams[0].emit("change", { fullDocument: { missionId: "copilot-u7" } });

		expect(ensure).toHaveBeenCalledWith("u7");
		stop();
	});

	it("ignores malformed change events", () => {
		const { db, streams } = fakeDb();
		const ensure = vi.fn().mockResolvedValue(undefined);
		const stop = startCopilotWaker(db, ensure);

		streams[0].emit("change", {});
		streams[0].emit("change", { fullDocument: null });
		streams[0].emit("change", { fullDocument: { missionId: "gold-digest" } });
		streams[0].emit("change", null);

		expect(ensure).not.toHaveBeenCalled();
		stop();
	});

	it("does not let a failing start crash the stream handler", async () => {
		const { db, streams } = fakeDb();
		const ensure = vi.fn().mockRejectedValue(new Error("boom"));
		const stop = startCopilotWaker(db, ensure);

		streams[0].emit("change", { fullDocument: { missionId: "copilot-u1" } });
		await vi.advanceTimersByTimeAsync(0);

		expect(ensure).toHaveBeenCalledTimes(1);
		stop();
	});

	it("reopens the stream after an error and rescans for mail it missed", async () => {
		let stranded: string[] = [];
		const { db, streams, aggregates } = fakeDb({
			strandedMissionIds: () => stranded,
		});
		const ensure = vi.fn().mockResolvedValue(undefined);
		const stop = startCopilotWaker(db, ensure, { scanIntervalMs: 10_000_000 });
		await vi.advanceTimersByTimeAsync(0); // startup scan
		const scansAtStart = aggregates.length;

		streams[0].emit("error", new Error("stream lost"));
		expect(streams[0].closed).toBe(true);
		expect(streams).toHaveLength(1); // waits for the backoff

		stranded = ["copilot-u3"]; // arrived while the stream was down
		await vi.advanceTimersByTimeAsync(2_000);

		expect(streams).toHaveLength(2);
		expect(aggregates.length).toBe(scansAtStart + 1);
		expect(ensure).toHaveBeenCalledWith("u3");
		stop();
	});

	it("scans at startup and on the interval", async () => {
		const { db, aggregates } = fakeDb();
		const stop = startCopilotWaker(db, vi.fn(), { scanIntervalMs: 60_000 });
		await vi.advanceTimersByTimeAsync(0);
		expect(aggregates).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(aggregates).toHaveLength(2);
		stop();
	});

	it("stop closes the stream and cancels every timer", async () => {
		const { db, streams, aggregates } = fakeDb();
		const stop = startCopilotWaker(db, vi.fn(), { scanIntervalMs: 60_000 });
		await vi.advanceTimersByTimeAsync(0);
		streams[0].emit("error", new Error("lost")); // pending reopen timer
		const scans = aggregates.length;

		stop();
		await vi.advanceTimersByTimeAsync(10 * 60_000);

		expect(aggregates).toHaveLength(scans);
		expect(streams).toHaveLength(1); // never reopened
	});
});
