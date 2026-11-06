/**
 * The Fly calls behind an in-place resume and a volume fork (#103): the
 * update keeps the machine stopped and carries the full config, a full volume
 * server surfaces as FlyCapacityError, and a fork is requested in another zone
 * and polled until mountable. Global fetch is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FlyCapacityError,
	provisionMission,
	updateMachine,
} from "../src/fly-machines.js";
import { forkVolume, waitForVolumeReady } from "../src/fly-volume-fork.js";

const ORIGINAL_ENV = { ...process.env };
let fetchMock: ReturnType<typeof vi.fn>;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

beforeEach(() => {
	process.env.FLY_MISSIONS_APP_NAME = "magi-missions-test";
	process.env.FLY_API_TOKEN_MACHINES = "test-token";
	process.env.FLY_MISSIONS_IMAGE = "registry.fly.io/magi-missions-test:abc";
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
	vi.unstubAllGlobals();
});

const body = (call: number) =>
	JSON.parse(fetchMock.mock.calls[call][1].body as string);

describe("updateMachine", () => {
	it("posts the full current config to the existing machine and leaves it stopped", async () => {
		fetchMock.mockResolvedValue(json({ id: "m-1", private_ip: "fdaa::9" }));
		const result = await updateMachine("m-1", "mission-1", "vol-1", {
			memoryMb: 2048,
		});
		expect(result).toEqual({ updated: true, privateIp: "fdaa::9" });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toMatch(/\/apps\/magi-missions-test\/machines\/m-1$/);
		expect(init.method).toBe("POST");
		const sent = body(0);
		expect(sent.skip_launch).toBe(true);
		expect(sent.config.image).toBe("registry.fly.io/magi-missions-test:abc");
		expect(sent.config.env.MISSION_ID).toBe("mission-1");
		expect(sent.config.mounts).toEqual([
			{ volume: "vol-1", path: "/missions" },
		]);
		expect(sent.config.guest.memory_mb).toBe(2048);
	});

	it("reports a machine that no longer exists instead of throwing", async () => {
		fetchMock.mockResolvedValue(json({ error: "not found" }, 404));
		expect(await updateMachine("m-1", "mission-1", "vol-1")).toEqual({
			updated: false,
		});
	});
});

describe("FlyCapacityError", () => {
	it("is what a create gets when the volume's server is full", async () => {
		fetchMock.mockResolvedValue(
			json(
				{
					error:
						"insufficient resources to create new machine with existing volume 'vol-1'",
					status: "volume_placement_capacity",
				},
				412,
			),
		);
		await expect(
			provisionMission("mission-1", { existingVolumeId: "vol-1" }),
		).rejects.toBeInstanceOf(FlyCapacityError);
	});

	it("is not used for other create failures", async () => {
		fetchMock.mockResolvedValue(json({ error: "bad image" }, 422));
		const err = await provisionMission("mission-1", {
			existingVolumeId: "vol-1",
		}).catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(FlyCapacityError);
	});
});

describe("forkVolume / waitForVolumeReady", () => {
	it("forks into another zone of the source's region, sized for the machine", async () => {
		fetchMock
			.mockResolvedValueOnce(
				json({ id: "vol-1", state: "created", region: "iad", zone: "31db" }),
			)
			.mockResolvedValueOnce(
				json({ id: "vol-2", state: "hydrating", region: "iad", zone: "834a" }),
			);
		const fork = await forkVolume("gold-digest-v2-20260628-1451", "vol-1", {
			cpuKind: "shared",
			cpus: 1,
			memoryMb: 1024,
		});
		expect(fork).toEqual({ volumeId: "vol-2", zone: "834a" });
		const sent = body(1);
		expect(sent).toMatchObject({
			region: "iad",
			source_volume_id: "vol-1",
			require_unique_zone: true,
			compute: { cpu_kind: "shared", cpus: 1, memory_mb: 1024 },
		});
		expect(sent.name).toMatch(/^[a-z0-9_]{1,30}$/);
	});

	it("polls until the fork is created", async () => {
		fetchMock
			.mockResolvedValueOnce(json({ id: "vol-2", state: "hydrating" }))
			.mockResolvedValueOnce(json({ id: "vol-2", state: "created" }));
		await waitForVolumeReady("vol-2", 1_000, 1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("gives up after the timeout, naming the volume and its state", async () => {
		fetchMock.mockImplementation(async () =>
			json({ id: "vol-2", state: "hydrating" }),
		);
		await expect(waitForVolumeReady("vol-2", 5, 1)).rejects.toThrow(
			/vol-2 is still "hydrating"/,
		);
	});
});
