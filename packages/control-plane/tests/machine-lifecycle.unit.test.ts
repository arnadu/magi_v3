/**
 * Tracked machine lifecycle (ADR-0031 Decision 1): every provision / stop /
 * restart / destroy also opens or closes a runtime segment. The raw Fly calls
 * are mocked; segments go to an in-memory fake.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	destroyMission,
	provisionMission,
	resumeMission,
	suspendMission,
} from "../src/fly-machines.js";
import {
	destroyTracked,
	provisionTracked,
	resumeTracked,
	suspendTracked,
} from "../src/machine-lifecycle.js";
import { fakeSegmentsDb } from "./support/fake-segments-db.js";

vi.mock("../src/fly-machines.js", () => ({
	provisionMission: vi.fn(),
	suspendMission: vi.fn(),
	resumeMission: vi.fn(),
	destroyMission: vi.fn(),
}));

const provision = vi.mocked(provisionMission);
const stop = vi.mocked(suspendMission);
const start = vi.mocked(resumeMission);
const destroy = vi.mocked(destroyMission);

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
		vi.spyOn(db, "collection").mockImplementation(() => {
			throw new Error("mongo down");
		});
		await expect(provisionTracked(db, "m1", {})).resolves.toEqual(handle);
		expect(err).toHaveBeenCalledWith(
			expect.stringContaining('missionId: "m1"'),
		);
		err.mockRestore();
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
