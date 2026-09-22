/**
 * OOM detection from Fly exit events (ADR-0032 Decision 2/4). Fixtures for
 * requested-stop and the `exit_code: 1` restart come from real dev machine
 * events captured 2026-09-20; the OOM-suspected cases (137, signal 9,
 * `oom_killed`) are synthetic since no live Fly-level OOM kill was captured
 * during this sprint's testing (see docs/plans/resource-management-implementation-plan.md
 * step 5.3) — this module has not been live-verified against a real OOM exit.
 */

import type { AlertStateStore } from "@magi/agent-runtime-worker";
import { describe, expect, it } from "vitest";
import { checkOomExits, classifyExit } from "../src/fly-events.js";
import type {
	FlyMachineEvent,
	FlyMachineSummary,
} from "../src/fly-machines.js";
import { type Doc, fakeDb } from "./support/fake-db.js";

function exitEvent(
	over: Partial<NonNullable<FlyMachineEvent["request"]>["exit_event"]>,
): FlyMachineEvent {
	return {
		type: "exit",
		timestamp: 1758360000000,
		request: { exit_event: { exited_at: "2026-09-20T12:00:00Z", ...over } },
	};
}

describe("classifyExit", () => {
	it("returns null for non-exit events", () => {
		expect(classifyExit({ type: "start" })).toBeNull();
	});

	it("returns null when there is no exit_event payload", () => {
		expect(classifyExit({ type: "exit", request: {} })).toBeNull();
	});

	it("classifies a requested stop, real dev fixture (2026-09-20)", () => {
		expect(
			classifyExit(exitEvent({ requested_stop: true, exit_code: 0 })),
		).toBe("requested-stop");
	});

	it("requested_stop wins even if the exit code also looks OOM-like", () => {
		expect(
			classifyExit(
				exitEvent({ requested_stop: true, exit_code: 137, signal: 9 }),
			),
		).toBe("requested-stop");
	});

	it("classifies a plain non-zero restart as other, real dev fixture (2026-09-20)", () => {
		expect(classifyExit(exitEvent({ exit_code: 1, restarting: true }))).toBe(
			"other",
		);
	});

	it("classifies exit_code 137 as oom-suspected", () => {
		expect(classifyExit(exitEvent({ exit_code: 137 }))).toBe("oom-suspected");
	});

	it("classifies signal 9 as oom-suspected", () => {
		expect(classifyExit(exitEvent({ signal: 9 }))).toBe("oom-suspected");
	});

	it("classifies guest_signal 9 as oom-suspected", () => {
		expect(classifyExit(exitEvent({ guest_signal: 9 }))).toBe("oom-suspected");
	});

	it("classifies oom_killed: true as oom-suspected regardless of exit code", () => {
		expect(classifyExit(exitEvent({ oom_killed: true, exit_code: 0 }))).toBe(
			"oom-suspected",
		);
	});
});

function setup(machines: FlyMachineSummary[], missions: Doc[] = []) {
	const { db, data } = fakeDb({
		missions,
		mailbox: [],
		missionAnomalies: [],
		resourceAlertState: [],
	});
	return {
		db,
		data,
		listMachinesFn: async () => machines,
	};
}

const missionDoc = (over: Doc = {}): Doc => ({
	missionId: "m1",
	userId: "u1",
	status: "running",
	machineId: "mach-1",
	...over,
});

describe("checkOomExits", () => {
	it("raises oom-suspected for a machine whose owning mission is on record", async () => {
		const { db, data, listMachinesFn } = setup(
			[{ id: "mach-1", events: [exitEvent({ exit_code: 137 })] }],
			[missionDoc()],
		);
		await checkOomExits(db, { listMachinesFn });

		expect(data.missionAnomalies).toHaveLength(1);
		expect(data.missionAnomalies[0]).toMatchObject({
			missionId: "m1",
			category: "oom-suspected",
			severity: "hard",
		});
		expect(
			data.mailbox.some(
				(m) =>
					m.missionId === "copilot-u1" &&
					(m.subject as string).includes("oom-suspected"),
			),
		).toBe(true);
	});

	it("does not raise anything for a requested stop", async () => {
		const { db, data, listMachinesFn } = setup(
			[{ id: "mach-1", events: [exitEvent({ requested_stop: true })] }],
			[missionDoc()],
		);
		await checkOomExits(db, { listMachinesFn });
		expect(data.missionAnomalies).toHaveLength(0);
	});

	it("does not raise anything for an ordinary non-zero exit", async () => {
		const { db, data, listMachinesFn } = setup(
			[
				{
					id: "mach-1",
					events: [exitEvent({ exit_code: 1, restarting: true })],
				},
			],
			[missionDoc()],
		);
		await checkOomExits(db, { listMachinesFn });
		expect(data.missionAnomalies).toHaveLength(0);
	});

	it("does not report the same exit twice across ticks", async () => {
		const machines = [
			{ id: "mach-1", events: [exitEvent({ exit_code: 137 })] },
		];
		const { db, data, listMachinesFn } = setup(machines, [missionDoc()]);

		await checkOomExits(db, { listMachinesFn });
		await checkOomExits(db, { listMachinesFn });

		expect(data.missionAnomalies).toHaveLength(1);
	});

	it("reports again for a later exit on the same machine (different exited_at)", async () => {
		const { db, data, listMachinesFn } = setup(
			[
				{
					id: "mach-1",
					events: [
						exitEvent({ exit_code: 137, exited_at: "2026-09-21T00:00:00Z" }),
					],
				},
			],
			[missionDoc()],
		);
		// Pre-seed dedup state for an earlier exit on the same machine.
		await db.collection("resourceAlertState").insertOne({
			_id: "mach-1:oom-suspected:2026-09-20T12:00:00Z",
			level: "hard",
			lastAlertAt: new Date(),
		} as never);

		await checkOomExits(db, { listMachinesFn });
		expect(data.missionAnomalies).toHaveLength(1);
	});

	it("skips events with no exited_at rather than risk re-reporting forever", async () => {
		const { db, data, listMachinesFn } = setup(
			[
				{
					id: "mach-1",
					events: [
						{ type: "exit", request: { exit_event: { exit_code: 137 } } },
					],
				},
			],
			[missionDoc()],
		);
		await checkOomExits(db, { listMachinesFn });
		expect(data.missionAnomalies).toHaveLength(0);
	});

	it("warns and skips when no mission owns the machine (already destroyed/re-provisioned)", async () => {
		const { db, data, listMachinesFn } = setup(
			[{ id: "mach-orphan", events: [exitEvent({ exit_code: 137 })] }],
			[],
		);
		await expect(
			checkOomExits(db, { listMachinesFn }),
		).resolves.toBeUndefined();
		expect(data.missionAnomalies).toHaveLength(0);
	});

	it("never throws when listMachines itself fails", async () => {
		const { db, data } = setup([], []);
		await expect(
			checkOomExits(db, {
				listMachinesFn: async () => {
					throw new Error("fly api down");
				},
			}),
		).resolves.toBeUndefined();
		expect(data.missionAnomalies).toHaveLength(0);
	});

	it("fails open on a broken dedup store — still raises the anomaly", async () => {
		const { db, data, listMachinesFn } = setup(
			[{ id: "mach-1", events: [exitEvent({ exit_code: 137 })] }],
			[missionDoc()],
		);
		const brokenStore: AlertStateStore = {
			get: async () => {
				throw new Error("store down");
			},
			put: async () => {
				throw new Error("store down");
			},
			clear: async () => {},
		};
		await checkOomExits(db, { listMachinesFn, dedupeStore: brokenStore });
		expect(data.missionAnomalies).toHaveLength(1);
	});

	it("processes every machine and every event on each machine", async () => {
		const { db, data, listMachinesFn } = setup(
			[
				{ id: "mach-1", events: [exitEvent({ exit_code: 137 })] },
				{
					id: "mach-2",
					events: [exitEvent({ signal: 9, exited_at: "2026-09-20T13:00:00Z" })],
				},
			],
			[
				missionDoc({ missionId: "m1", machineId: "mach-1" }),
				missionDoc({ missionId: "m2", userId: "u2", machineId: "mach-2" }),
			],
		);
		await checkOomExits(db, { listMachinesFn });
		expect(data.missionAnomalies.map((a) => a.missionId).sort()).toEqual([
			"m1",
			"m2",
		]);
	});
});
