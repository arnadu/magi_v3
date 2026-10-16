/**
 * Scheduler delivery — the machine wake-up branch. scheduler.unit.test.ts
 * never sets `machineId`, so this is the only place the branch runs: Fly's
 * state lookup and the lifecycle layer are mocked, Mongo is the shared fake.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMachineState } from "../src/fly-machines.js";
import { wakeTracked } from "../src/machine-lifecycle.js";
import { deliver } from "../src/scheduler.js";
import { fakeDb } from "./support/fake-db.js";

vi.mock("../src/fly-machines.js", () => ({ getMachineState: vi.fn() }));
vi.mock("../src/machine-lifecycle.js", () => ({ wakeTracked: vi.fn() }));
vi.mock("../src/resource-upgrade.js", () => ({
	createUpgradeSweeper: vi.fn(),
}));

const state = vi.mocked(getMachineState);
const wake = vi.mocked(wakeTracked);

const due = new Date(Date.now() - 60_000);

function scenario(mission: Record<string, unknown>) {
	return fakeDb({
		missions: [
			{
				missionId: "m1",
				userId: "u1",
				machineId: "mach-old",
				volumeId: "vol-1",
				mission: { memoryMb: 2048 },
				...mission,
			},
		],
		scheduled_messages: [
			{
				_id: "s1",
				missionId: "m1",
				to: ["lead"],
				subject: "brief",
				body: "go",
				deliverAt: due,
				status: "pending",
			},
		],
	});
}

beforeEach(() => {
	vi.resetAllMocks();
	wake.mockResolvedValue({ reprovisioned: false, machineId: "mach-old" });
});

describe("deliver — waking the mission's machine", () => {
	it("leaves a started machine alone and delivers", async () => {
		state.mockResolvedValue("started");
		const { db, data } = scenario({});
		await deliver(db);
		expect(wake).not.toHaveBeenCalled();
		expect(data.mailbox).toHaveLength(1);
		expect(data.scheduled_messages[0].status).toBe("delivered");
	});

	it("wakes a stopped machine through wakeTracked with the volume, so a gone machine is re-provisioned", async () => {
		state.mockResolvedValue("stopped");
		const { db, data } = scenario({});
		await deliver(db);
		expect(wake).toHaveBeenCalledWith(db, {
			missionId: "m1",
			machineId: "mach-old",
			volumeId: "vol-1",
			mission: { memoryMb: 2048 },
		});
		expect(data.mailbox).toHaveLength(1);
	});

	it("treats a machine Fly no longer knows (state lookup throws) as needing a wake, not as a delivery failure", async () => {
		state.mockRejectedValue(new Error("404"));
		wake.mockResolvedValue({ reprovisioned: true, machineId: "mach-new" });
		const { db, data } = scenario({});
		await deliver(db);
		expect(wake).toHaveBeenCalledTimes(1);
		expect(data.mailbox).toHaveLength(1);
		expect(data.scheduled_messages[0].status).toBe("delivered");
	});

	it("does not wake during a resize (the re-created machine reads the mailbox on boot)", async () => {
		state.mockResolvedValue("stopped");
		const { db, data } = scenario({ resize: { claimedAt: new Date() } });
		await deliver(db);
		expect(wake).not.toHaveBeenCalled();
		expect(data.mailbox).toHaveLength(1);
	});

	it("counts a failed wake as a delivery attempt and reopens the message", async () => {
		state.mockResolvedValue("stopped");
		wake.mockRejectedValue(new Error("Volume vol-1 does not exist on Fly"));
		const { db, data } = scenario({});
		await deliver(db);
		expect(data.mailbox ?? []).toHaveLength(0);
		expect(data.scheduled_messages[0]).toMatchObject({
			status: "pending",
			deliveryAttempts: 1,
		});
	});
});
