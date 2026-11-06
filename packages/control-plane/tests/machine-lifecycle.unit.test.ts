/**
 * Tracked machine lifecycle (ADR-0031 Decision 1): every provision / stop /
 * restart / destroy also opens or closes a runtime segment. The raw Fly calls
 * are mocked; segments go to an in-memory fake.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	deleteMachine,
	destroyMission,
	FlyCapacityError,
	machineExists,
	provisionMission,
	resumeMission,
	suspendMission,
	updateMachine,
	volumeExists,
} from "../src/fly-machines.js";
import { forkVolume, waitForVolumeReady } from "../src/fly-volume-fork.js";
import {
	destroyTracked,
	provisionOnVolumeTracked,
	provisionTracked,
	ResizeError,
	resizeTracked,
	restartOnCurrentConfigTracked,
	resumeTracked,
	suspendTracked,
	wakeTracked,
} from "../src/machine-lifecycle.js";
import { fakeDb } from "./support/fake-db.js";
import { fakeSegmentsDb } from "./support/fake-segments-db.js";

vi.mock("../src/fly-machines.js", () => ({
	provisionMission: vi.fn(),
	suspendMission: vi.fn(),
	resumeMission: vi.fn(),
	destroyMission: vi.fn(),
	deleteMachine: vi.fn(),
	updateMachine: vi.fn(),
	machineExists: vi.fn(),
	volumeExists: vi.fn(),
	FlyCapacityError: class FlyCapacityError extends Error {},
}));
vi.mock("../src/fly-volume-fork.js", () => ({
	forkVolume: vi.fn(),
	waitForVolumeReady: vi.fn(),
}));

const provision = vi.mocked(provisionMission);
const stop = vi.mocked(suspendMission);
const start = vi.mocked(resumeMission);
const destroy = vi.mocked(destroyMission);
const exists = vi.mocked(machineExists);
const volExists = vi.mocked(volumeExists);

const handle = { machineId: "mach-1", privateIp: "::1", volumeId: "vol-1" };

beforeEach(() => {
	vi.resetAllMocks();
	provision.mockResolvedValue(handle);
	stop.mockResolvedValue(undefined);
	start.mockResolvedValue(undefined);
	destroy.mockResolvedValue(undefined);
});

describe("provisionTracked", () => {
	it("provisions and opens a default-shape segment", async () => {
		const { db, segments } = fakeSegmentsDb();
		const result = await provisionTracked(db, "m1", {});

		expect(result).toEqual(handle);
		expect(segments).toHaveLength(1);
		expect(segments[0]).toMatchObject({
			missionId: "m1",
			machineId: "mach-1",
			shape: { cpuKind: "shared", cpus: 1, memoryMb: 1024 },
			upgraded: false,
		});
		expect(segments[0].endedAt).toBeUndefined();
	});

	it("records the requested shape and the upgrade tracking fields", async () => {
		const { db, segments } = fakeSegmentsDb();
		const plannedEndAt = new Date(Date.now() + 3_600_000);
		await provisionTracked(
			db,
			"m1",
			{
				cpuKind: "performance",
				cpus: 2,
				memoryMb: 8192,
				existingVolumeId: "v",
			},
			{ upgraded: true, plannedEndAt, requestedByAgentId: "analyst" },
		);
		expect(provision).toHaveBeenCalledWith("m1", {
			cpuKind: "performance",
			cpus: 2,
			memoryMb: 8192,
			existingVolumeId: "v",
		});
		expect(segments[0]).toMatchObject({
			shape: { cpuKind: "performance", cpus: 2, memoryMb: 8192 },
			upgraded: true,
			plannedEndAt,
			requestedByAgentId: "analyst",
		});
	});

	it("does not touch segments when provisioning fails", async () => {
		const { db, segments } = fakeSegmentsDb();
		provision.mockRejectedValue(new Error("Fly quota"));
		await expect(provisionTracked(db, "m1", {})).rejects.toThrow("Fly quota");
		expect(segments).toHaveLength(0);
	});

	it("still returns the machine when the segment write fails, logging the failure", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const { db } = fakeSegmentsDb();
		const realCollection = db.collection.bind(db);
		vi.spyOn(db, "collection").mockImplementation(((name: string) => {
			if (name === "machineSegments") throw new Error("mongo down");
			return realCollection(name);
		}) as typeof db.collection);
		await expect(provisionTracked(db, "m1", {})).resolves.toEqual(handle);
		expect(err).toHaveBeenCalledWith(
			expect.stringContaining('missionId: "m1"'),
		);
		err.mockRestore();
	});

	it("never starts a machine when the mission's spend cap cannot be ensured (SCH-4)", async () => {
		const { db } = fakeSegmentsDb();
		const realCollection = db.collection.bind(db);
		vi.spyOn(db, "collection").mockImplementation(((name: string) => {
			if (name === "missions") throw new Error("mongo down");
			return realCollection(name);
		}) as typeof db.collection);
		provision.mockClear();
		await expect(provisionTracked(db, "m1", {})).rejects.toThrow("mongo down");
		expect(provision).not.toHaveBeenCalled();
	});

	it("replaces a stale open segment instead of leaving two open", async () => {
		const { db, segments } = fakeSegmentsDb();
		await provisionTracked(db, "m1", {});
		provision.mockResolvedValue({ ...handle, machineId: "mach-2" });
		await provisionTracked(db, "m1", {});
		expect(segments.filter((s) => s.endedAt === undefined)).toHaveLength(1);
		expect(segments).toHaveLength(2);
	});
});

describe("suspendTracked", () => {
	it("stops the machine, then closes the open segment", async () => {
		const { db, segments } = fakeSegmentsDb();
		await provisionTracked(db, "m1", {});
		await suspendTracked(db, "m1", "mach-1");

		expect(stop).toHaveBeenCalledWith("mach-1");
		expect(segments[0].endedAt).toBeInstanceOf(Date);
	});

	it("leaves the segment open when the stop fails, since the machine is still running", async () => {
		const { db, segments } = fakeSegmentsDb();
		await provisionTracked(db, "m1", {});
		stop.mockRejectedValue(new Error("Fly down"));
		await expect(suspendTracked(db, "m1", "mach-1")).rejects.toThrow(
			"Fly down",
		);
		expect(segments[0].endedAt).toBeUndefined();
	});
});

describe("resumeTracked", () => {
	it("starts the machine and opens a segment on the mission's default shape", async () => {
		const { db, segments } = fakeSegmentsDb();
		await resumeTracked(db, {
			missionId: "m1",
			machineId: "mach-1",
			mission: { memoryMb: 2048, cpus: 2 },
		});
		expect(start).toHaveBeenCalledWith("mach-1");
		expect(segments[0]).toMatchObject({
			missionId: "m1",
			machineId: "mach-1",
			shape: { cpuKind: "shared", cpus: 2, memoryMb: 2048 },
			upgraded: false,
		});
	});

	it("falls back to the platform default when the mission has no sizing", async () => {
		const { db, segments } = fakeSegmentsDb();
		await resumeTracked(db, { missionId: "m1", machineId: "mach-1" });
		expect(segments[0].shape).toEqual({
			cpuKind: "shared",
			cpus: 1,
			memoryMb: 1024,
		});
	});

	it("opens no segment when the start fails", async () => {
		const { db, segments } = fakeSegmentsDb();
		start.mockRejectedValue(new Error("cannot start"));
		await expect(
			resumeTracked(db, { missionId: "m1", machineId: "mach-1" }),
		).rejects.toThrow("cannot start");
		expect(segments).toHaveLength(0);
	});
});

describe("destroyTracked", () => {
	it("destroys the machine and volume, then closes the open segment", async () => {
		const { db, segments } = fakeSegmentsDb();
		await provisionTracked(db, "m1", {});
		await destroyTracked(db, "m1", "mach-1", "vol-1");
		expect(destroy).toHaveBeenCalledWith("mach-1", "vol-1");
		expect(segments[0].endedAt).toBeInstanceOf(Date);
	});
});

describe("wakeTracked", () => {
	const mission = () => ({
		missionId: "m1",
		userId: "u1",
		status: "suspended",
		machineId: "mach-old",
		volumeId: "vol-1",
		errorMessage: "earlier failure",
	});

	it("starts the machine when it still exists and marks the mission running", async () => {
		exists.mockResolvedValue(true);
		const { db, segments, missions } = fakeSegmentsDb({
			missions: [mission()],
		});
		const result = await wakeTracked(db, {
			missionId: "m1",
			machineId: "mach-old",
			volumeId: "vol-1",
		});
		expect(result).toEqual({ reprovisioned: false, machineId: "mach-old" });
		expect(start).toHaveBeenCalledWith("mach-old");
		expect(provision).not.toHaveBeenCalled();
		expect(segments).toHaveLength(1);
		expect(missions[0]).toMatchObject({
			status: "running",
			machineId: "mach-old",
		});
	});

	it("re-provisions on the volume when the machine is gone, and rewrites machineId/privateIp/status", async () => {
		exists.mockResolvedValue(false);
		volExists.mockResolvedValue(true);
		const { db, segments, missions } = fakeSegmentsDb({
			missions: [mission()],
		});
		const result = await wakeTracked(db, {
			missionId: "m1",
			machineId: "mach-old",
			volumeId: "vol-1",
			mission: { memoryMb: 2048, cpus: 2 },
		});
		expect(result).toEqual({ reprovisioned: true, machineId: "mach-1" });
		expect(start).not.toHaveBeenCalled();
		expect(provision).toHaveBeenCalledWith("m1", {
			existingVolumeId: "vol-1",
			memoryMb: 2048,
			cpus: 2,
		});
		expect(segments[0]).toMatchObject({ machineId: "mach-1" });
		expect(missions[0]).toMatchObject({
			status: "running",
			machineId: "mach-1",
			privateIp: "::1",
		});
		expect(missions[0].errorMessage).toBeUndefined();
	});

	it("refuses when the machine is gone and the recorded volume does not exist (drifted volumeId)", async () => {
		exists.mockResolvedValue(false);
		volExists.mockResolvedValue(false);
		const { db, missions } = fakeSegmentsDb({ missions: [mission()] });
		await expect(
			wakeTracked(db, {
				missionId: "m1",
				machineId: "mach-old",
				volumeId: "vol-1",
			}),
		).rejects.toThrow(/likely drifted/);
		expect(provision).not.toHaveBeenCalled();
		expect(missions[0].status).toBe("suspended");
	});

	it("refuses when the machine is gone and no volumeId is recorded", async () => {
		exists.mockResolvedValue(false);
		const { db } = fakeSegmentsDb({ missions: [mission()] });
		await expect(
			wakeTracked(db, { missionId: "m1", machineId: "mach-old" }),
		).rejects.toThrow(/no volumeId/);
		expect(volExists).not.toHaveBeenCalled();
	});

	it("does nothing for a local developer daemon", async () => {
		const { db, segments } = fakeSegmentsDb({ missions: [mission()] });
		const result = await wakeTracked(db, {
			missionId: "m1",
			machineId: "local-m1",
		});
		expect(result).toEqual({ reprovisioned: false, machineId: "local-m1" });
		expect(exists).not.toHaveBeenCalled();
		expect(segments).toHaveLength(0);
	});
});

describe("resizeTracked", () => {
	const shape = { cpuKind: "performance" as const, cpus: 2, memoryMb: 8192 };
	const mission = { missionId: "m1", machineId: "old", volumeId: "vol-1" };

	it("points the mission at the new machine as soon as it is provisioned (RU5)", async () => {
		vi.mocked(deleteMachine).mockResolvedValue(undefined);
		const { db, missions } = fakeSegmentsDb({
			missions: [{ missionId: "m1", machineId: "old", privateIp: "::9" }],
		});
		const result = await resizeTracked(db, mission, shape, { upgraded: true });
		expect(result).toEqual(handle);
		expect(missions[0]).toMatchObject({
			machineId: "mach-1",
			privateIp: "::1",
		});
	});

	it("fails at the record stage, naming the running machine, when the mission cannot be updated", async () => {
		vi.mocked(deleteMachine).mockResolvedValue(undefined);
		const { db } = fakeSegmentsDb();
		const broken = {
			collection: (name: string) =>
				name === "missions"
					? {
							updateOne: async () => {
								throw new Error("write blocked");
							},
						}
					: db.collection(name),
		} as typeof db;
		vi.useFakeTimers();
		try {
			const pending = resizeTracked(broken, mission, shape, { upgraded: true });
			const settled = pending.catch((e: unknown) => e);
			await vi.runAllTimersAsync();
			const err = (await settled) as ResizeError;
			expect(err).toBeInstanceOf(ResizeError);
			expect(err.stage).toBe("record");
			expect(err.message).toContain("mach-1");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("restartOnCurrentConfigTracked (#103)", () => {
	const update = vi.mocked(updateMachine);
	const del = vi.mocked(deleteMachine);
	const target = {
		missionId: "m1",
		machineId: "mach-old",
		volumeId: "vol-1",
		mission: { memoryMb: 2048, cpus: 2 },
	};

	it("updates the stopped machine in place and starts it, keeping its id and placement", async () => {
		update.mockResolvedValue({ updated: true, privateIp: "::7" });
		const { db, segments } = fakeSegmentsDb({
			missions: [{ missionId: "m1" }],
		});
		const result = await restartOnCurrentConfigTracked(db, target);
		expect(result).toEqual({
			machineId: "mach-old",
			privateIp: "::7",
			volumeId: "vol-1",
			how: "updated",
		});
		expect(update).toHaveBeenCalledWith("mach-old", "m1", "vol-1", {
			cpuKind: "shared",
			cpus: 2,
			memoryMb: 2048,
		});
		expect(start).toHaveBeenCalledWith("mach-old");
		expect(del).not.toHaveBeenCalled();
		expect(provision).not.toHaveBeenCalled();
		expect(segments[0]).toMatchObject({ machineId: "mach-old" });
	});

	it("re-creates on the volume, without a delete, when the machine is gone", async () => {
		update.mockResolvedValue({ updated: false });
		const { db } = fakeSegmentsDb({ missions: [{ missionId: "m1" }] });
		const result = await restartOnCurrentConfigTracked(db, target);
		expect(result.how).toBe("recreated");
		expect(del).not.toHaveBeenCalled();
		expect(provision).toHaveBeenCalledWith("m1", {
			existingVolumeId: "vol-1",
			memoryMb: 2048,
			cpus: 2,
		});
	});

	it("deletes and re-creates when the in-place start fails", async () => {
		update.mockResolvedValue({ updated: true, privateIp: "::7" });
		start.mockRejectedValue(new Error("Failed to start machine: 500"));
		const { db } = fakeSegmentsDb({ missions: [{ missionId: "m1" }] });
		const result = await restartOnCurrentConfigTracked(db, target);
		expect(result).toMatchObject({ machineId: "mach-1", how: "recreated" });
		expect(del).toHaveBeenCalledWith("mach-old");
	});
});

describe("provisionOnVolumeTracked (#103)", () => {
	const fork = vi.mocked(forkVolume);
	const ready = vi.mocked(waitForVolumeReady);
	const full = () =>
		new FlyCapacityError(
			'Failed to create machine: 412 {"status":"volume_placement_capacity"}',
		);
	const seed = () =>
		fakeDb({
			missions: [{ missionId: "m1", userId: "u1", volumeId: "vol-1" }],
			machineSegments: [],
		});

	it("forks the volume when its server is full, repoints the mission, and provisions on the fork", async () => {
		provision.mockRejectedValueOnce(full()).mockResolvedValueOnce({
			...handle,
			volumeId: "vol-fork",
		});
		fork.mockResolvedValue({ volumeId: "vol-fork", zone: "834a" });
		ready.mockResolvedValue(undefined);
		const { db, data } = seed();
		const result = await provisionOnVolumeTracked(db, {
			missionId: "m1",
			volumeId: "vol-1",
		});
		expect(result.how).toBe("forked");
		expect(fork).toHaveBeenCalledWith("m1", "vol-1", {
			cpuKind: "shared",
			cpus: 1,
			memoryMb: 1024,
		});
		expect(ready).toHaveBeenCalledWith("vol-fork");
		expect(provision).toHaveBeenLastCalledWith(
			"m1",
			expect.objectContaining({ existingVolumeId: "vol-fork" }),
		);
		expect(data.missions[0].volumeId).toBe("vol-fork");
		expect(destroy).not.toHaveBeenCalled();
		expect(data.missionAnomalies[0]).toMatchObject({
			category: "volume-forked",
			severity: "soft",
		});
		expect(data.missionAnomalies[0].message).toContain("vol-1");
	});

	it("records the fork before waiting for it, so a timeout leaves a resumable mission", async () => {
		provision.mockRejectedValueOnce(full());
		fork.mockResolvedValue({ volumeId: "vol-fork" });
		ready.mockRejectedValue(new Error('Volume vol-fork is still "hydrating"'));
		const { db, data } = seed();
		await expect(
			provisionOnVolumeTracked(db, { missionId: "m1", volumeId: "vol-1" }),
		).rejects.toThrow(/hydrating/);
		expect(data.missions[0].volumeId).toBe("vol-fork");
		expect(provision).toHaveBeenCalledTimes(1);
	});

	it("refuses to use the fork when the mission's volumeId changed meanwhile", async () => {
		provision.mockRejectedValueOnce(full());
		fork.mockResolvedValue({ volumeId: "vol-fork" });
		const { db, data } = fakeDb({
			missions: [{ missionId: "m1", userId: "u1", volumeId: "vol-other" }],
			machineSegments: [],
		});
		await expect(
			provisionOnVolumeTracked(db, { missionId: "m1", volumeId: "vol-1" }),
		).rejects.toThrow(/not attached/);
		expect(data.missions[0].volumeId).toBe("vol-other");
		expect(ready).not.toHaveBeenCalled();
	});

	it("does not fork on any other provisioning failure", async () => {
		provision.mockRejectedValueOnce(new Error("Failed to create machine: 500"));
		const { db } = seed();
		await expect(
			provisionOnVolumeTracked(db, { missionId: "m1", volumeId: "vol-1" }),
		).rejects.toThrow(/500/);
		expect(fork).not.toHaveBeenCalled();
	});
});
