/**
 * Disk usage sampler (ADR-0032 Decision 2, closes G-4). No real filesystem,
 * no real `du`/`statfs`, no real MongoDB — everything injected.
 */

import type { Db } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import type { AnomalyRecorder } from "../src/anomaly.js";
import type { AlertStateStore } from "../src/resource-alert-state.js";
import {
	parseTopDirectories,
	type ResourceSamplerDeps,
	sampleDiskUsage,
} from "../src/resource-sampler.js";

function fakeDb() {
	const docs: Record<string, unknown>[] = [];
	const calls: unknown[] = [];
	const db = {
		collection(name: string) {
			expect(name).toBe("missionResources");
			return {
				async updateOne(
					filter: { missionId: string },
					update: { $set: Record<string, unknown> },
					opts: unknown,
				) {
					calls.push({ filter, update, opts });
					const existing = docs.find((d) => d.missionId === filter.missionId);
					if (existing) Object.assign(existing, update.$set);
					else docs.push({ ...update.$set });
				},
			};
		},
	} as unknown as Db;
	return { db, docs, calls };
}

function fakeStore(): AlertStateStore & {
	puts: Array<{ key: string; level: string }>;
} {
	const state = new Map<string, { level: string; lastAlertAt: Date }>();
	const puts: Array<{ key: string; level: string }> = [];
	return {
		puts,
		async get(key) {
			const s = state.get(key);
			return s
				? { key, level: s.level as "soft" | "hard", lastAlertAt: s.lastAlertAt }
				: null;
		},
		async put(s) {
			state.set(s.key, s);
			puts.push({ key: s.key, level: s.level });
		},
		async clear(key) {
			state.delete(key);
		},
	};
}

function fakeRecorder(): AnomalyRecorder & {
	records: Array<Record<string, unknown>>;
} {
	const records: Array<Record<string, unknown>> = [];
	return {
		records,
		async record(a) {
			records.push(a);
		},
	};
}

function baseDeps(over: Partial<ResourceSamplerDeps> = {}): {
	deps: ResourceSamplerDeps;
	db: ReturnType<typeof fakeDb>;
	store: ReturnType<typeof fakeStore>;
	recorder: ReturnType<typeof fakeRecorder>;
} {
	const db = fakeDb();
	const store = fakeStore();
	const recorder = fakeRecorder();
	const deps: ResourceSamplerDeps = {
		db: db.db,
		anomalyRecorder: recorder,
		missionId: "m1",
		workdir: "/missions",
		rssMb: 300,
		runningJobs: 0,
		alertsEnabled: true,
		alertStore: store,
		statfsFn: vi
			.fn()
			.mockResolvedValue({ blocks: 1000, bavail: 500, bsize: 1024 }), // 50% used
		duFn: vi.fn().mockResolvedValue(""),
		...over,
	};
	return { deps, db, store, recorder };
}

describe("parseTopDirectories", () => {
	it("parses SIZE_KB\\tPATH lines, sorted largest first, capped at the limit", () => {
		const output = [
			"100\t/missions/shared",
			"5000\t/missions/home/analyst",
			"200\t/missions/home/lead",
		].join("\n");
		expect(parseTopDirectories(output, 2)).toEqual([
			{ kb: 5000, path: "/missions/home/analyst" },
			{ kb: 200, path: "/missions/home/lead" },
		]);
	});

	it("skips blank lines and permission-error lines mixed into stdout", () => {
		const output = [
			"100\t/missions/shared",
			"",
			"du: cannot read directory '/missions/home/x': Permission denied",
			"200\t/missions/home/lead",
		].join("\n");
		expect(parseTopDirectories(output)).toEqual([
			{ kb: 200, path: "/missions/home/lead" },
			{ kb: 100, path: "/missions/shared" },
		]);
	});

	it("returns an empty array for empty or entirely-unparseable output", () => {
		expect(parseTopDirectories("")).toEqual([]);
		expect(parseTopDirectories("not du output at all")).toEqual([]);
	});

	it("handles paths containing spaces", () => {
		expect(parseTopDirectories("42\t/missions/shared/my folder")).toEqual([
			{ kb: 42, path: "/missions/shared/my folder" },
		]);
	});
});

describe("sampleDiskUsage", () => {
	it("stores the sample with rssMb and runningJobs, below the soft threshold: no alert", async () => {
		const { deps, db, recorder } = baseDeps({
			statfsFn: vi
				.fn()
				.mockResolvedValue({ blocks: 1000, bavail: 900, bsize: 1024 }), // 10%
		});
		await sampleDiskUsage(deps);

		expect(db.docs).toEqual([
			expect.objectContaining({
				missionId: "m1",
				diskTotalBytes: 1000 * 1024,
				diskUsedBytes: 100 * 1024,
				rssMb: 300,
				runningJobs: 0,
			}),
		]);
		expect(recorder.records).toHaveLength(0);
	});

	it("upserts on the missionId filter", async () => {
		const { deps, db } = baseDeps();
		await sampleDiskUsage(deps);
		expect(db.calls[0]).toMatchObject({
			filter: { missionId: "m1" },
			opts: { upsert: true },
		});
	});

	it("raises a soft disk-usage-high anomaly with a directory breakdown at 80%+", async () => {
		const { deps, recorder, store } = baseDeps({
			statfsFn: vi
				.fn()
				.mockResolvedValue({ blocks: 1000, bavail: 190, bsize: 1024 }), // 81%
			duFn: vi.fn().mockResolvedValue("500000\t/missions/home/analyst"),
		});
		await sampleDiskUsage(deps);

		expect(recorder.records).toHaveLength(1);
		expect(recorder.records[0]).toMatchObject({
			missionId: "m1",
			category: "disk-usage-high",
			severity: "soft",
		});
		expect(String(recorder.records[0].message)).toContain("81%");
		expect(String(recorder.records[0].message)).toContain(
			"/missions/home/analyst",
		);
		expect(store.puts).toEqual([{ key: "m1:disk-usage-high", level: "soft" }]);
	});

	it("raises hard at 90%+", async () => {
		const { deps, recorder } = baseDeps({
			statfsFn: vi
				.fn()
				.mockResolvedValue({ blocks: 1000, bavail: 50, bsize: 1024 }), // 95%
		});
		await sampleDiskUsage(deps);
		expect(recorder.records[0]).toMatchObject({ severity: "hard" });
	});

	it("still alerts, without a breakdown, when du fails", async () => {
		const { deps, recorder } = baseDeps({
			statfsFn: vi
				.fn()
				.mockResolvedValue({ blocks: 1000, bavail: 190, bsize: 1024 }),
			duFn: vi.fn().mockRejectedValue(new Error("du timed out")),
		});
		await sampleDiskUsage(deps);
		expect(recorder.records).toHaveLength(1);
		expect(String(recorder.records[0].message)).not.toContain(
			"Largest directories",
		);
	});

	it("skips the alert entirely in local dev (alertsEnabled: false), but still stores the sample", async () => {
		const { deps, db, recorder } = baseDeps({
			alertsEnabled: false,
			statfsFn: vi
				.fn()
				.mockResolvedValue({ blocks: 1000, bavail: 50, bsize: 1024 }), // 95%
		});
		await sampleDiskUsage(deps);
		expect(db.docs).toHaveLength(1);
		expect(recorder.records).toHaveLength(0);
	});

	it("never throws when statfs fails, and stores nothing", async () => {
		const { deps, db, recorder } = baseDeps({
			statfsFn: vi.fn().mockRejectedValue(new Error("ENOENT")),
		});
		await expect(sampleDiskUsage(deps)).resolves.toBeUndefined();
		expect(db.docs).toHaveLength(0);
		expect(recorder.records).toHaveLength(0);
	});

	it("never throws when the Mongo write fails, and still evaluates the alert", async () => {
		const { deps, recorder } = baseDeps({
			statfsFn: vi
				.fn()
				.mockResolvedValue({ blocks: 1000, bavail: 50, bsize: 1024 }),
		});
		deps.db = {
			collection() {
				return {
					async updateOne() {
						throw new Error("mongo down");
					},
				};
			},
		} as unknown as Db;
		await expect(sampleDiskUsage(deps)).resolves.toBeUndefined();
		expect(recorder.records).toHaveLength(1);
	});

	it("fails open when the alert store itself is down: still alerts rather than staying silent", async () => {
		const { deps, recorder } = baseDeps({
			statfsFn: vi
				.fn()
				.mockResolvedValue({ blocks: 1000, bavail: 50, bsize: 1024 }), // 95%
			alertStore: {
				async get() {
					throw new Error("store down");
				},
				async put() {
					throw new Error("store down");
				},
				async clear() {},
			},
		});
		await expect(sampleDiskUsage(deps)).resolves.toBeUndefined();
		expect(recorder.records).toHaveLength(1);
		expect(recorder.records[0]).toMatchObject({ severity: "hard" });
	});

	it("never throws when the anomaly recorder itself fails", async () => {
		const { deps } = baseDeps({
			statfsFn: vi
				.fn()
				.mockResolvedValue({ blocks: 1000, bavail: 50, bsize: 1024 }),
			anomalyRecorder: {
				async record() {
					throw new Error("recorder down");
				},
			},
		});
		await expect(sampleDiskUsage(deps)).resolves.toBeUndefined();
	});

	it("does not alert or divide by zero when diskTotalBytes is 0", async () => {
		const { deps, recorder } = baseDeps({
			statfsFn: vi
				.fn()
				.mockResolvedValue({ blocks: 0, bavail: 0, bsize: 1024 }),
		});
		await expect(sampleDiskUsage(deps)).resolves.toBeUndefined();
		expect(recorder.records).toHaveLength(0);
	});
});
