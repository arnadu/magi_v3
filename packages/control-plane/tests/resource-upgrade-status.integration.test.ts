/**
 * GetMissionStatus's ADR-0031 extension (tier, time-on-tier, cumulative
 * upgraded runtime), its ADR-0032 step 6.2 disk-sample line, and its
 * issue-#62 follow-up live volume-verification line, against real
 * MongoDB. `getMachineState`/`volumeExists` are mocked so this stays a pure
 * Mongo integration test — no live Fly calls.
 */

import { randomUUID } from "node:crypto";
import type { Db, MongoClient } from "mongodb";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { connectMongo } from "../../agent-runtime-worker/src/mongo.js";
import {
	createCopilotTools,
	PendingActionsStore,
} from "../src/copilot-tools.js";
import { volumeExists } from "../src/fly-machines.js";

vi.mock("../src/fly-machines.js", () => ({
	getMachineState: vi.fn(),
	volumeExists: vi.fn(),
}));

const mockedVolumeExists = vi.mocked(volumeExists);

describe("GetMissionStatus — machine tier and upgraded runtime", () => {
	// biome-ignore lint/style/noNonNullAssertion: required env var; vitest.setup.ts validates presence
	const MONGODB_URI = process.env.MONGODB_URI!;
	let client: MongoClient;
	let db: Db;
	const userId = `user-${randomUUID()}`;
	const missionId = `status-tier-${randomUUID()}`;

	// One connection for the whole file: this Atlas cluster's connect time is
	// 10s+, and a per-test reconnect flaked on a DNS/SRV lookup timeout.
	beforeAll(async () => {
		({ client, db } = await connectMongo(MONGODB_URI, "magi-test"));
	}, 60_000);

	afterAll(async () => {
		await client.close();
	});

	afterEach(async () => {
		await db.collection("missions").deleteMany({ missionId });
		await db.collection("machineSegments").deleteMany({ missionId });
		await db.collection("missionResources").deleteMany({ missionId });
		vi.clearAllMocks();
	});

	function status() {
		const tools = createCopilotTools(
			db,
			() => {},
			new PendingActionsStore(),
			userId,
		);
		const tool = tools.find((t) => t.name === "GetMissionStatus");
		if (!tool) throw new Error("GetMissionStatus not found");
		return tool.execute("t1", { missionId });
	}

	it("reports the default tier and zero upgraded runtime with no machine at all", async () => {
		const now = new Date();
		await db.collection("missions").insertOne({
			missionId,
			userId,
			name: "Test",
			teamConfig: "",
			status: "running",
			createdAt: now,
			updatedAt: now,
		});

		const r = await status();
		expect(r.isError).toBeFalsy();
		const text = r.content[0].text;
		expect(text).toContain("tier:      shared, 1 CPU, 1024 MB (default)");
		expect(text).toContain("upgradedRuntime: 0.0 h / 24 h");
		expect(text).toContain("onTierSince: (unknown");
	});

	it("reports the mission's own default sizing when set", async () => {
		const now = new Date();
		await db.collection("missions").insertOne({
			missionId,
			userId,
			name: "Test",
			teamConfig: "",
			status: "running",
			mission: { memoryMb: 2048, cpus: 2 },
			createdAt: now,
			updatedAt: now,
		});

		const text = (await status()).content[0].text;
		expect(text).toContain("tier:      shared, 2 CPUs, 2048 MB (default)");
	});

	it("reports an upgraded tier, its expiry, and time on it from the open segment", async () => {
		const now = new Date();
		const expiresAt = new Date(now.getTime() + 30 * 60_000);
		const startedAt = new Date(now.getTime() - 5 * 60_000);
		await db.collection("missions").insertOne({
			missionId,
			userId,
			name: "Test",
			teamConfig: "",
			status: "running",
			upgrade: { cpuKind: "performance", cpus: 2, memoryMb: 8192, expiresAt },
			createdAt: now,
			updatedAt: now,
		});
		await db.collection("machineSegments").insertOne({
			missionId,
			machineId: "m1",
			shape: { cpuKind: "performance", cpus: 2, memoryMb: 8192 },
			upgraded: true,
			startedAt,
		});

		const text = (await status()).content[0].text;
		expect(text).toContain(
			"tier:      performance, 2 CPUs, 8192 MB (upgraded, expires",
		);
		expect(text).toContain(expiresAt.toISOString());
		expect(text).toContain(`onTierSince: ${startedAt.toISOString()}`);
	});

	it("computes cumulative upgraded runtime from closed segments since the last reset", async () => {
		const now = new Date();
		await db.collection("missions").insertOne({
			missionId,
			userId,
			name: "Test",
			teamConfig: "",
			status: "running",
			upgradedRuntimeResetAt: new Date(now.getTime() - 10 * 3_600_000),
			createdAt: now,
			updatedAt: now,
		});
		await db.collection("machineSegments").insertMany([
			{
				missionId,
				machineId: "old",
				shape: { cpuKind: "performance", cpus: 1, memoryMb: 2048 },
				upgraded: true,
				// Entirely before the reset — must not count.
				startedAt: new Date(now.getTime() - 20 * 3_600_000),
				endedAt: new Date(now.getTime() - 15 * 3_600_000),
			},
			{
				missionId,
				machineId: "recent",
				shape: { cpuKind: "performance", cpus: 1, memoryMb: 2048 },
				upgraded: true,
				startedAt: new Date(now.getTime() - 3 * 3_600_000),
				endedAt: new Date(now.getTime() - 1 * 3_600_000),
			},
		]);

		const text = (await status()).content[0].text;
		expect(text).toContain("upgradedRuntime: 2.0 h / 24 h");
	});

	it("reports 'no sample yet' before the disk sampler has ever run", async () => {
		const now = new Date();
		await db.collection("missions").insertOne({
			missionId,
			userId,
			name: "Test",
			teamConfig: "",
			status: "running",
			createdAt: now,
			updatedAt: now,
		});

		const text = (await status()).content[0].text;
		expect(text).toContain("disk:      (no sample yet)");
	});

	it("reports the latest disk sample and its age", async () => {
		const now = new Date();
		await db.collection("missions").insertOne({
			missionId,
			userId,
			name: "Test",
			teamConfig: "",
			status: "running",
			createdAt: now,
			updatedAt: now,
		});
		await db.collection("missionResources").insertOne({
			missionId,
			diskUsedBytes: 5 * 1024 ** 3,
			diskTotalBytes: 10 * 1024 ** 3,
			rssMb: 120,
			runningJobs: 0,
			updatedAt: new Date(now.getTime() - 3 * 60_000),
		});

		const text = (await status()).content[0].text;
		expect(text).toContain("disk:      5.0 / 10.0 GB");
		expect(text).toContain("min old)");
	});

	it("reports '(no volumeId on record)' when the mission has none", async () => {
		const now = new Date();
		await db.collection("missions").insertOne({
			missionId,
			userId,
			name: "Test",
			teamConfig: "",
			status: "running",
			createdAt: now,
			updatedAt: now,
		});

		const text = (await status()).content[0].text;
		expect(text).toContain("volume:    (no volumeId on record)");
		expect(mockedVolumeExists).not.toHaveBeenCalled();
	});

	it("reports the volume as verified when it exists on Fly", async () => {
		const now = new Date();
		mockedVolumeExists.mockResolvedValue(true);
		await db.collection("missions").insertOne({
			missionId,
			userId,
			name: "Test",
			teamConfig: "",
			status: "running",
			volumeId: "vol_real",
			createdAt: now,
			updatedAt: now,
		});

		const text = (await status()).content[0].text;
		expect(text).toContain("volumeId:  vol_real (verified on Fly)");
		expect(mockedVolumeExists).toHaveBeenCalledWith("vol_real");
	});

	it("flags a drifted volumeId as NOT FOUND on Fly", async () => {
		const now = new Date();
		mockedVolumeExists.mockResolvedValue(false);
		await db.collection("missions").insertOne({
			missionId,
			userId,
			name: "Test",
			teamConfig: "",
			status: "error",
			volumeId: "vol_gone",
			createdAt: now,
			updatedAt: now,
		});

		const text = (await status()).content[0].text;
		expect(text).toContain("volumeId:  vol_gone (NOT FOUND on Fly");
		expect(text).toContain("mission-recovery skill");
	});

	it("does not call volumeExists for a local-execution mission", async () => {
		const now = new Date();
		await db.collection("missions").insertOne({
			missionId,
			userId,
			name: "Test",
			teamConfig: "",
			status: "running",
			machineId: "local-status-tier",
			volumeId: `local-${missionId}`,
			createdAt: now,
			updatedAt: now,
		});

		const text = (await status()).content[0].text;
		expect(text).toContain("(local execution — not a real Fly volume)");
		expect(mockedVolumeExists).not.toHaveBeenCalled();
	});

	it("reports a verification error without throwing when the Fly call itself fails", async () => {
		const now = new Date();
		mockedVolumeExists.mockRejectedValue(new Error("fly api down"));
		await db.collection("missions").insertOne({
			missionId,
			userId,
			name: "Test",
			teamConfig: "",
			status: "running",
			volumeId: "vol_real",
			createdAt: now,
			updatedAt: now,
		});

		const r = await status();
		expect(r.isError).toBeFalsy();
		const text = r.content[0].text;
		expect(text).toContain(
			"volumeId:  vol_real (could not verify: fly api down)",
		);
	});
});
