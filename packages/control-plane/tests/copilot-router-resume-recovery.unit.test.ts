/**
 * copilot-router.ts's executeAction — resume_mission's destroyed-machine
 * fallback and fix_mission_volume (issue #62 follow-up,
 * docs/plans/mission-volume-drift-recovery-plan.md Step 3). Fly and the
 * machine-lifecycle layer are mocked; a minimal in-memory fake stands in for
 * Mongo, matching this repo's existing mock-based test style for this file
 * (see copilot-router-execute-action.unit.test.ts). `flyVolumeName` is kept
 * real (pure, deterministic) via importActual.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeAction } from "../src/copilot-router.js";
import type { PendingAction } from "../src/copilot-tools.js";
import { flyVolumeName, listVolumes } from "../src/fly-machines.js";
import { wakeTracked } from "../src/machine-lifecycle.js";

vi.mock("../src/fly-machines.js", async () => {
	const actual = await vi.importActual<typeof import("../src/fly-machines.js")>(
		"../src/fly-machines.js",
	);
	return {
		...actual,
		isLocalExecution: vi.fn(() => false),
		provisionLocal: vi.fn(),
		listVolumes: vi.fn(),
		machineExists: vi.fn(),
		volumeExists: vi.fn(),
	};
});
// The start-or-reprovision decision itself lives in machine-lifecycle.ts and
// is tested there (machine-lifecycle.unit.test.ts, "wakeTracked"); here only
// the hand-off and the operator-facing message are checked.
vi.mock("../src/machine-lifecycle.js", () => ({
	wakeTracked: vi.fn(),
}));

const mockedListVolumes = vi.mocked(listVolumes);
const mockedWakeTracked = vi.mocked(wakeTracked);

interface MissionDoc {
	missionId: string;
	userId: string;
	status: string;
	machineId?: string;
	privateIp?: string;
	volumeId?: string;
	errorMessage?: string;
	mission?: { memoryMb?: number; cpus?: number };
	updatedAt?: Date;
}

function fakeDb(missions: MissionDoc[]) {
	function matchesMission(doc: MissionDoc, filter: Record<string, unknown>) {
		return Object.entries(filter).every(([key, val]) => {
			const docVal = (doc as Record<string, unknown>)[key];
			if (val && typeof val === "object" && "$ne" in (val as object)) {
				return docVal !== (val as { $ne: unknown }).$ne;
			}
			return docVal === val;
		});
	}
	// biome-ignore lint/suspicious/noExplicitAny: minimal fake, not a full Db
	const fake: any = {
		collection(name: string) {
			if (name !== "missions")
				throw new Error(`fakeDb: unexpected collection "${name}"`);
			return {
				async findOne(filter: Record<string, unknown>) {
					return missions.find((m) => matchesMission(m, filter)) ?? null;
				},
				find(filter: Record<string, unknown>) {
					return {
						async toArray() {
							return missions.filter((m) => matchesMission(m, filter));
						},
					};
				},
				async updateOne(
					filter: { missionId: string },
					update: {
						$set?: Partial<MissionDoc>;
						$unset?: Record<string, string>;
					},
				) {
					const doc = missions.find((m) => m.missionId === filter.missionId);
					if (doc) {
						if (update.$set) Object.assign(doc, update.$set);
						if (update.$unset) {
							for (const key of Object.keys(update.$unset)) {
								delete (doc as Record<string, unknown>)[key];
							}
						}
					}
					return { acknowledged: true };
				},
			};
		},
	};
	return fake;
}

function action(type: string, payload: unknown): PendingAction {
	return {
		id: "action-1",
		userId: "user1",
		type,
		label: type,
		payload,
		createdAt: new Date(),
	};
}

const missionM1 = (over: Partial<MissionDoc> = {}): MissionDoc => ({
	missionId: "m1",
	userId: "user1",
	status: "error",
	machineId: "old-machine",
	volumeId: "vol_real",
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("executeAction: resume_mission — hands off to wakeTracked", () => {
	it("passes the mission's machine, volume and shape, and reports a plain resume", async () => {
		mockedWakeTracked.mockResolvedValue({
			reprovisioned: false,
			machineId: "old-machine",
		});
		const missions = [
			missionM1({ status: "suspended", mission: { memoryMb: 2048 } }),
		];
		const db = fakeDb(missions);

		const result = await executeAction(
			db,
			action("resume_mission", { missionId: "m1" }),
			"user1",
		);

		expect(result).toBe('Mission "m1" resumed');
		expect(mockedWakeTracked).toHaveBeenCalledWith(db, {
			missionId: "m1",
			machineId: "old-machine",
			volumeId: "vol_real",
			mission: { memoryMb: 2048 },
		});
	});

	it("tells the operator when the machine had to be re-provisioned", async () => {
		mockedWakeTracked.mockResolvedValue({
			reprovisioned: true,
			machineId: "new-machine",
		});
		const db = fakeDb([missionM1({ errorMessage: "boom" })]);

		const result = await executeAction(
			db,
			action("resume_mission", { missionId: "m1" }),
			"user1",
		);

		expect(result).toContain("machine had been destroyed");
		expect(result).toContain("new-machine");
	});

	it("surfaces wakeTracked's refusal (e.g. a drifted volumeId) unchanged", async () => {
		mockedWakeTracked.mockRejectedValue(
			new Error(
				'Volume vol_real does not exist on Fly — mission.volumeId in MongoDB has likely drifted. Try ProposeAction "fix_mission_volume" first.',
			),
		);
		const db = fakeDb([missionM1()]);

		await expect(
			executeAction(db, action("resume_mission", { missionId: "m1" }), "user1"),
		).rejects.toThrow(/mission\.volumeId in MongoDB has likely drifted/);
	});

	it("refuses a mission with no machine before calling the lifecycle layer", async () => {
		const db = fakeDb([missionM1({ machineId: undefined })]);
		await expect(
			executeAction(db, action("resume_mission", { missionId: "m1" }), "user1"),
		).rejects.toThrow(/has no machine/);
		expect(mockedWakeTracked).not.toHaveBeenCalled();
	});
});

describe("executeAction: fix_mission_volume", () => {
	it("corrects the volumeId when exactly one unclaimed candidate matches by name", async () => {
		const expectedName = flyVolumeName("m1");
		mockedListVolumes.mockResolvedValue([
			{ id: "vol_new_real", name: expectedName },
			{ id: "vol_unrelated", name: "some_other_mission" },
		]);
		const missions = [missionM1({ volumeId: "vol_stale" })];
		const db = fakeDb(missions);

		const result = await executeAction(
			db,
			action("fix_mission_volume", { missionId: "m1" }),
			"user1",
		);

		expect(result).toContain("corrected to vol_new_real");
		expect(missions[0].volumeId).toBe("vol_new_real");
	});

	it("refuses when no candidate volume matches the expected name", async () => {
		mockedListVolumes.mockResolvedValue([
			{ id: "vol_unrelated", name: "some_other_mission" },
		]);
		const missions = [missionM1()];
		const db = fakeDb(missions);

		await expect(
			executeAction(
				db,
				action("fix_mission_volume", { missionId: "m1" }),
				"user1",
			),
		).rejects.toThrow(/No unclaimed Fly volume named/);
		expect(missions[0].volumeId).toBe("vol_real");
	});

	it("refuses on an ambiguous match rather than guessing", async () => {
		const expectedName = flyVolumeName("m1");
		mockedListVolumes.mockResolvedValue([
			{ id: "vol_candidate_a", name: expectedName },
			{ id: "vol_candidate_b", name: expectedName },
		]);
		const missions = [missionM1()];
		const db = fakeDb(missions);

		await expect(
			executeAction(
				db,
				action("fix_mission_volume", { missionId: "m1" }),
				"user1",
			),
		).rejects.toThrow(/Ambiguous/);
		expect(missions[0].volumeId).toBe("vol_real");
	});

	it("excludes a same-named volume already claimed by another active mission", async () => {
		const expectedName = flyVolumeName("m1");
		mockedListVolumes.mockResolvedValue([
			{ id: "vol_claimed", name: expectedName },
		]);
		const missions = [
			missionM1(),
			{
				missionId: "m2",
				userId: "user1",
				status: "running",
				volumeId: "vol_claimed",
			},
		];
		const db = fakeDb(missions);

		await expect(
			executeAction(
				db,
				action("fix_mission_volume", { missionId: "m1" }),
				"user1",
			),
		).rejects.toThrow(/No unclaimed Fly volume named/);
	});

	it("does not exclude a same-named volume claimed only by a destroyed mission", async () => {
		const expectedName = flyVolumeName("m1");
		mockedListVolumes.mockResolvedValue([
			{ id: "vol_reclaimable", name: expectedName },
		]);
		const missions = [
			missionM1(),
			{
				missionId: "m2",
				userId: "user1",
				status: "destroyed",
				volumeId: "vol_reclaimable",
			},
		];
		const db = fakeDb(missions);

		const result = await executeAction(
			db,
			action("fix_mission_volume", { missionId: "m1" }),
			"user1",
		);
		expect(result).toContain("corrected to vol_reclaimable");
	});

	it("throws when the mission itself is not found", async () => {
		const db = fakeDb([]);
		await expect(
			executeAction(
				db,
				action("fix_mission_volume", { missionId: "ghost" }),
				"user1",
			),
		).rejects.toThrow('Mission "ghost" not found');
	});
});
