/**
 * Resource alert de-duplication and hysteresis, and the shared thresholds
 * they depend on (ADR-0032 Decision 3). No MongoDB: an in-memory store, plus a
 * fake collection for the Mongo-backed store.
 */

import type { Db } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import {
	type AlertState,
	type AlertStateStore,
	createMongoAlertStateStore,
	evaluateAlert,
	levelFor,
} from "../src/resource-alert-state.js";
import {
	ALERT_CLEAR_HYSTERESIS,
	ATLAS_STORAGE,
	DISK_USAGE,
	REPORT_FLAGS,
	SPEND_CAP,
	SPEND_SPIKE_RATIO,
	UPGRADE_CAP_NEAR,
	UPGRADE_IDLE,
	UPGRADE_LIMITS,
} from "../src/resource-thresholds.js";

function memoryStore(): AlertStateStore & { states: Map<string, AlertState> } {
	const states = new Map<string, AlertState>();
	return {
		states,
		async get(key) {
			return states.get(key) ?? null;
		},
		async put(state) {
			states.set(state.key, state);
		},
		async clear(key) {
			states.delete(key);
		},
	};
}

/** Hours after a fixed origin. */
const at = (hours: number) =>
	new Date(Date.UTC(2026, 8, 20) + hours * 3_600_000);

describe("thresholds", () => {
	it.each([
		["DISK_USAGE", DISK_USAGE],
		["ATLAS_STORAGE", ATLAS_STORAGE],
		["SPEND_CAP", SPEND_CAP],
	])("%s: 0 < soft < hard <= 1, and hysteresis fits below soft", (_n, t) => {
		expect(t.soft).toBeGreaterThan(0);
		expect(t.soft).toBeLessThan(t.hard);
		expect(t.hard).toBeLessThanOrEqual(1);
		expect(t.soft - ALERT_CLEAR_HYSTERESIS).toBeGreaterThan(0);
		// A downgrade is recorded only below hard - hysteresis, which must still be
		// above the soft threshold's own clearing point.
		expect(t.hard - ALERT_CLEAR_HYSTERESIS).toBeGreaterThan(
			t.soft - ALERT_CLEAR_HYSTERESIS,
		);
	});

	it.each([
		["UPGRADE_CAP_NEAR", UPGRADE_CAP_NEAR],
		["UPGRADE_IDLE", UPGRADE_IDLE],
		["SPEND_SPIKE_RATIO", SPEND_SPIKE_RATIO],
	])("%s: soft-only — hard is unreachable, soft is positive", (_n, t) => {
		expect(t.soft).toBeGreaterThan(0);
		expect(t.hard).toBe(Number.POSITIVE_INFINITY);
	});

	it("upgrade limits are mutually consistent", () => {
		expect(UPGRADE_LIMITS.maxWindowMinutes).toBe(60);
		expect(UPGRADE_LIMITS.reminderBufferMinutes).toBeLessThan(
			UPGRADE_LIMITS.maxWindowMinutes,
		);
		expect(UPGRADE_LIMITS.resizeCooldownMinutes).toBeGreaterThan(0);
		expect(UPGRADE_LIMITS.maxMemoryMb % 256).toBe(0);
		expect(UPGRADE_LIMITS.cumulativeCapHours).toBe(24);
	});

	it("report flag windows are sensible", () => {
		expect(REPORT_FLAGS.chronicUpgradeDays).toBeLessThanOrEqual(
			REPORT_FLAGS.chronicUpgradeWindowDays,
		);
	});
});

describe("levelFor", () => {
	it.each([
		[0, null],
		[0.79, null],
		[0.8, "soft"],
		[0.89, "soft"],
		[0.9, "hard"],
		[1.2, "hard"],
	])("disk ratio %s → %s", (ratio, expected) => {
		expect(levelFor(ratio, DISK_USAGE)).toBe(expected);
	});
});

describe("evaluateAlert", () => {
	const KEY = "m1:disk-usage-high";

	it("stays quiet and stores nothing below the soft threshold", async () => {
		const store = memoryStore();
		expect(await evaluateAlert(store, KEY, 0.5, DISK_USAGE, at(0))).toBeNull();
		expect(store.states.size).toBe(0);
	});

	it("alerts on first crossing and records it", async () => {
		const store = memoryStore();
		expect(await evaluateAlert(store, KEY, 0.82, DISK_USAGE, at(0))).toBe(
			"soft",
		);
		expect(store.states.get(KEY)).toMatchObject({ level: "soft" });
	});

	it("does not repeat at the same level within 24 h, and repeats at 24 h", async () => {
		const store = memoryStore();
		await evaluateAlert(store, KEY, 0.82, DISK_USAGE, at(0));
		expect(
			await evaluateAlert(store, KEY, 0.83, DISK_USAGE, at(23.9)),
		).toBeNull();
		expect(await evaluateAlert(store, KEY, 0.83, DISK_USAGE, at(24))).toBe(
			"soft",
		);
		// The repeat resets the clock.
		expect(
			await evaluateAlert(store, KEY, 0.83, DISK_USAGE, at(25)),
		).toBeNull();
	});

	it("escalates soft → hard immediately", async () => {
		const store = memoryStore();
		await evaluateAlert(store, KEY, 0.82, DISK_USAGE, at(0));
		expect(await evaluateAlert(store, KEY, 0.91, DISK_USAGE, at(0.01))).toBe(
			"hard",
		);
	});

	it("does not de-escalate to a soft alert while still near the hard line", async () => {
		const store = memoryStore();
		await evaluateAlert(store, KEY, 0.92, DISK_USAGE, at(0));
		// 0.88 is in the soft band but not clearly below hard (0.9 - 0.05 = 0.85).
		expect(await evaluateAlert(store, KEY, 0.88, DISK_USAGE, at(1))).toBeNull();
		expect(store.states.get(KEY)?.level).toBe("hard");
		// After 24 h the current (soft) reading alerts at its own level.
		expect(await evaluateAlert(store, KEY, 0.88, DISK_USAGE, at(24))).toBe(
			"soft",
		);
	});

	it("records a clear drop out of the hard band silently, so a later rise alerts again", async () => {
		const store = memoryStore();
		await evaluateAlert(store, KEY, 0.92, DISK_USAGE, at(0));
		expect(await evaluateAlert(store, KEY, 0.84, DISK_USAGE, at(1))).toBeNull();
		expect(store.states.get(KEY)?.level).toBe("soft");
		expect(await evaluateAlert(store, KEY, 0.91, DISK_USAGE, at(2))).toBe(
			"hard",
		);
	});

	it("forgets the state only once clearly below the soft threshold, then alerts fresh", async () => {
		const store = memoryStore();
		await evaluateAlert(store, KEY, 0.81, DISK_USAGE, at(0));
		// Between soft - hysteresis (0.75) and soft: quiet, state kept.
		expect(await evaluateAlert(store, KEY, 0.77, DISK_USAGE, at(1))).toBeNull();
		expect(store.states.has(KEY)).toBe(true);
		// Clearly below: forgotten.
		expect(await evaluateAlert(store, KEY, 0.74, DISK_USAGE, at(2))).toBeNull();
		expect(store.states.has(KEY)).toBe(false);
		// A new crossing within the 24 h window alerts again because state was cleared.
		expect(await evaluateAlert(store, KEY, 0.81, DISK_USAGE, at(3))).toBe(
			"soft",
		);
	});

	it("does not flap when a reading hovers around the soft threshold", async () => {
		const store = memoryStore();
		const readings = [0.81, 0.79, 0.81, 0.79, 0.81];
		const emitted: unknown[] = [];
		for (const [i, r] of readings.entries()) {
			emitted.push(await evaluateAlert(store, KEY, r, DISK_USAGE, at(i)));
		}
		expect(emitted.filter((e) => e !== null)).toEqual(["soft"]);
	});

	it("keeps separate keys independent", async () => {
		const store = memoryStore();
		await evaluateAlert(store, "m1:disk-usage-high", 0.85, DISK_USAGE, at(0));
		expect(
			await evaluateAlert(store, "m2:disk-usage-high", 0.85, DISK_USAGE, at(0)),
		).toBe("soft");
	});

	it("works with other thresholds (Atlas: 70% soft, 85% hard)", async () => {
		const store = memoryStore();
		expect(
			await evaluateAlert(store, "platform:atlas", 0.7, ATLAS_STORAGE, at(0)),
		).toBe("soft");
		expect(
			await evaluateAlert(store, "platform:atlas", 0.86, ATLAS_STORAGE, at(1)),
		).toBe("hard");
	});
});

describe("evaluateAlert when the state store is down", () => {
	const failingStore: AlertStateStore = {
		async get() {
			throw new Error("mongo down");
		},
		async put() {
			throw new Error("mongo down");
		},
		async clear() {
			throw new Error("mongo down");
		},
	};

	it.each([
		[0.5, null],
		[0.85, "soft"],
		[0.95, "hard"],
	])("fails open: ratio %s still yields %s, never a missed alert", async (ratio, expected) => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await evaluateAlert(failingStore, "k", ratio, DISK_USAGE)).toBe(
			expected,
		);
		expect(err).toHaveBeenCalledWith(expect.stringContaining('key: "k"'));
		err.mockRestore();
	});

	it("fails open when only the write fails", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const store: AlertStateStore = {
			...memoryStore(),
			async put() {
				throw new Error("write blocked");
			},
		};
		expect(await evaluateAlert(store, "k", 0.95, DISK_USAGE)).toBe("hard");
		err.mockRestore();
	});
});

describe("createMongoAlertStateStore", () => {
	function fakeDb() {
		const docs = new Map<
			string,
			{ _id: string; level: string; lastAlertAt: Date }
		>();
		const calls: { op: string; args: unknown[] }[] = [];
		const db = {
			collection(name: string) {
				expect(name).toBe("resourceAlertState");
				return {
					async findOne(filter: { _id: string }) {
						return docs.get(filter._id) ?? null;
					},
					async updateOne(
						filter: { _id: string },
						update: { $set: { level: string; lastAlertAt: Date } },
						opts: unknown,
					) {
						calls.push({ op: "updateOne", args: [filter, update, opts] });
						docs.set(filter._id, { _id: filter._id, ...update.$set });
					},
					async deleteOne(filter: { _id: string }) {
						calls.push({ op: "deleteOne", args: [filter] });
						docs.delete(filter._id);
					},
				};
			},
		} as unknown as Db;
		return { db, calls };
	}

	it("round-trips state keyed by _id, upserting on put", async () => {
		const { db, calls } = fakeDb();
		const store = createMongoAlertStateStore(db);
		expect(await store.get("k")).toBeNull();

		await store.put({ key: "k", level: "hard", lastAlertAt: at(3) });
		expect(calls[0]).toEqual({
			op: "updateOne",
			args: [
				{ _id: "k" },
				{ $set: { level: "hard", lastAlertAt: at(3) } },
				{ upsert: true },
			],
		});
		expect(await store.get("k")).toEqual({
			key: "k",
			level: "hard",
			lastAlertAt: at(3),
		});

		await store.clear("k");
		expect(await store.get("k")).toBeNull();
	});
});
