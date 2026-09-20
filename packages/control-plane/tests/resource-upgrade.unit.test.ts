/**
 * Temporary machine upgrades (ADR-0031): request, renew, revert, the expiry
 * sweeper and suspend-with-revert. The Fly resize itself is mocked
 * (machine-lifecycle.resizeTracked); Mongo is an in-memory fake, so the real
 * state transitions, claims and notifications are exercised.
 */

import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isLocalExecution } from "../src/fly-machines.js";
import {
	ResizeError,
	resizeTracked,
	suspendTracked,
} from "../src/machine-lifecycle.js";
import {
	requestUpgrade,
	revertUpgrade,
	sanitizeReason,
	suspendMissionMachine,
	sweepUpgrades,
} from "../src/resource-upgrade.js";
import { type Doc, fakeDb } from "./support/fake-db.js";

vi.mock("../src/fly-machines.js", () => ({
	isLocalExecution: vi.fn(),
	provisionMission: vi.fn(),
	suspendMission: vi.fn(),
	resumeMission: vi.fn(),
	destroyMission: vi.fn(),
	deleteMachine: vi.fn(),
}));
vi.mock("../src/machine-lifecycle.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/machine-lifecycle.js")>();
	return { ...actual, resizeTracked: vi.fn(), suspendTracked: vi.fn() };
});

const resize = vi.mocked(resizeTracked);
const suspend = vi.mocked(suspendTracked);

const NOW = new Date("2026-09-20T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms: number) => new Date(NOW.getTime() + ms);

// Built at runtime so this file contains no raw control characters.
const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);

const BIG = { cpuKind: "performance", cpus: 2, memoryMb: 8192 } as const;
const OTHER = { cpuKind: "shared", cpus: 2, memoryMb: 4096 } as const;
const DEFAULT = { cpuKind: "shared", cpus: 1, memoryMb: 1024 } as const;

function missionDoc(over: Doc = {}): Doc {
	return {
		missionId: "m1",
		userId: "u1",
		status: "running",
		machineId: "mach-1",
		privateIp: "fdaa::1",
		volumeId: "vol-1",
		mission: { memoryMb: 1024, cpus: 1 },
		agents: [{ id: "analyst" }, { id: "lead" }],
		...over,
	};
}

type MissionView = Doc & {
	upgrade?: Doc & { expiresAt: Date; reminderId?: string };
	resize?: { claimedAt?: Date; lastAt?: Date };
};

function setup(
	m: Doc | null = missionDoc(),
	extra: Record<string, Doc[]> = {},
) {
	const { db, data } = fakeDb({
		missions: m ? [m] : [],
		machineSegments: [],
		mailbox: [],
		scheduled_messages: [],
		missionAnomalies: [],
		resourceAlertState: [],
		...extra,
	});
	return {
		db,
		data,
		mission: () => data.missions[0] as MissionView,
		mail: (subject: string) =>
			data.mailbox.filter((d) => d.subject === subject),
	};
}

const request = (over: Doc = {}) => ({
	...BIG,
	durationMinutes: 30,
	reason: "10 GB pandas transform",
	requestedByAgentId: "analyst",
	...over,
});

const upgradeState = (over: Doc = {}) => ({
	...BIG,
	expiresAt: at(10 * MIN),
	requestedByAgentId: "analyst",
	...over,
});

function upgradedSegment(
	startMs: number,
	endMs: number | null,
	over: Doc = {},
): Doc {
	return {
		missionId: "m1",
		shape: BIG,
		upgraded: true,
		startedAt: at(startMs),
		...(endMs === null ? {} : { endedAt: at(endMs) }),
		...over,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(isLocalExecution).mockReturnValue(false);
	resize.mockResolvedValue({
		machineId: "mach-2",
		privateIp: "fdaa::2",
		volumeId: "vol-1",
	});
	suspend.mockResolvedValue(undefined);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("sanitizeReason", () => {
	it("turns control characters into spaces and collapses whitespace", () => {
		expect(sanitizeReason(`a${NUL}b${ESC}[31m\n\tc  d${DEL}`)).toBe(
			"a b [31m c d",
		);
	});
	it("cuts to 500 characters with an ellipsis", () => {
		const out = sanitizeReason("x".repeat(600));
		expect(out).toHaveLength(501);
		expect(out.endsWith("…")).toBe(true);
	});
	it("returns empty for non-strings", () => {
		expect(sanitizeReason(undefined)).toBe("");
		expect(sanitizeReason(42)).toBe("");
	});
});

describe("requestUpgrade — new upgrade", () => {
	it("resizes, records the upgrade, schedules a reminder and notifies everyone", async () => {
		const t = setup();
		const r = await requestUpgrade(t.db, "m1", request(), NOW);

		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ action: "upgraded", shape: BIG });
		expect(resize).toHaveBeenCalledWith(
			t.db,
			{ missionId: "m1", machineId: "mach-1", volumeId: "vol-1" },
			BIG,
			{
				upgraded: true,
				plannedEndAt: at(30 * MIN),
				requestedByAgentId: "analyst",
			},
		);

		const m = t.mission();
		expect(m).toMatchObject({ machineId: "mach-2", privateIp: "fdaa::2" });
		expect(m.upgrade).toMatchObject({ ...BIG, requestedByAgentId: "analyst" });
		expect(m.upgrade?.expiresAt).toEqual(at(30 * MIN));
		expect(m.resize?.lastAt).toEqual(NOW);
		expect(m.resize?.claimedAt).toBeUndefined();

		expect(t.data.scheduled_messages).toHaveLength(1);
		const reminder = t.data.scheduled_messages[0];
		expect(reminder).toMatchObject({
			missionId: "m1",
			to: ["mission-copilot", "analyst"],
			status: "pending",
		});
		expect(reminder.deliverAt).toEqual(at(20 * MIN));
		expect((reminder._id as ObjectId).toHexString()).toBe(
			m.upgrade?.reminderId,
		);

		const note = t.mail("Machine upgraded");
		expect(note).toHaveLength(1);
		expect(note[0]).toMatchObject({
			from: "system",
			to: ["user", "mission-copilot", "analyst"],
		});
		expect(String(note[0].body)).toContain("10 GB pandas transform");
		expect(String(note[0].body)).toContain("re-run from scratch");
	});

	it("addresses the reminder to the mission-copilot alone when nobody asked", async () => {
		const t = setup();
		await requestUpgrade(
			t.db,
			"m1",
			request({ requestedByAgentId: undefined }),
			NOW,
		);
		expect(t.data.scheduled_messages[0].to).toEqual(["mission-copilot"]);
		expect(t.mail("Machine upgraded")[0].to).toEqual([
			"user",
			"mission-copilot",
		]);
	});

	it("places the reminder halfway through a window shorter than the buffer", async () => {
		const t = setup();
		await requestUpgrade(t.db, "m1", request({ durationMinutes: 5 }), NOW);
		expect(t.data.scheduled_messages[0].deliverAt).toEqual(at(2.5 * MIN));
	});

	it("sanitises and caps the agent's reason before it reaches anyone", async () => {
		const t = setup();
		await requestUpgrade(
			t.db,
			"m1",
			request({ reason: `bad${ESC}[2J ${"y".repeat(700)}` }),
			NOW,
		);
		const body = String(t.mail("Machine upgraded")[0].body);
		expect(body).not.toContain(ESC);
		expect(body).not.toContain("y".repeat(501));
	});

	it.each([
		[
			"a missing duration",
			{ durationMinutes: undefined },
			/durationMinutes is required/,
		],
		["a duration over 60 minutes", { durationMinutes: 61 }, /1 to 60/],
		["a shape above the maximum size", { cpus: 4, memoryMb: 32768 }, /outside/],
		["no reason", { reason: undefined }, /reason is required/],
		["a blank reason", { reason: "  \n " }, /reason is required/],
		[
			"a requester who is not on the roster",
			{ requestedByAgentId: "stranger" },
			/not an agent of this mission/,
		],
		[
			"the mission-copilot as requester",
			{ requestedByAgentId: "mission-copilot" },
			/not an agent/,
		],
		["the default machine", { ...DEFAULT }, /default machine/],
	])("rejects %s without touching the machine", async (_n, over, message) => {
		const t = setup();
		const r = await requestUpgrade(t.db, "m1", request(over), NOW);
		expect(r.status).toBe(400);
		expect(String(r.body.error)).toMatch(message);
		expect(resize).not.toHaveBeenCalled();
		expect(t.mission().upgrade).toBeUndefined();
	});

	it("404s an unknown mission, 409s one that is not running, 501s local execution", async () => {
		expect(
			(await requestUpgrade(setup(null).db, "m1", request(), NOW)).status,
		).toBe(404);
		expect(
			(
				await requestUpgrade(
					setup(missionDoc({ status: "suspended" })).db,
					"m1",
					request(),
					NOW,
				)
			).status,
		).toBe(409);
		expect(
			(
				await requestUpgrade(
					setup(missionDoc({ machineId: "local-m1" })).db,
					"m1",
					request(),
					NOW,
				)
			).status,
		).toBe(501);
		expect(resize).not.toHaveBeenCalled();
	});

	it("refuses while another resize holds the claim", async () => {
		const t = setup(missionDoc({ resize: { claimedAt: at(-MIN) } }));
		const r = await requestUpgrade(t.db, "m1", request(), NOW);
		expect(r.status).toBe(409);
		expect(String(r.body.error)).toMatch(/already in progress/);
		expect(resize).not.toHaveBeenCalled();
	});

	describe("cooldown", () => {
		it("rejects a shape change within 5 minutes of the last resize", async () => {
			const t = setup(missionDoc({ resize: { lastAt: at(-2 * MIN) } }));
			const r = await requestUpgrade(t.db, "m1", request(), NOW);
			expect(r.status).toBe(429);
			expect(resize).not.toHaveBeenCalled();
		});
		it("allows it after 5 minutes", async () => {
			const t = setup(missionDoc({ resize: { lastAt: at(-6 * MIN) } }));
			expect((await requestUpgrade(t.db, "m1", request(), NOW)).status).toBe(
				200,
			);
		});
	});

	describe("cumulative cap", () => {
		it("allows a request that lands exactly on 24 h", async () => {
			const t = setup(undefined, {
				machineSegments: [upgradedSegment(-40 * HOUR, -16.5 * HOUR)],
			}); // 23.5 h
			expect(
				(
					await requestUpgrade(
						t.db,
						"m1",
						request({ durationMinutes: 30 }),
						NOW,
					)
				).status,
			).toBe(200);
		});

		it("rejects one minute over, records a hard anomaly, and tells the operator how to reset", async () => {
			const t = setup(undefined, {
				machineSegments: [upgradedSegment(-40 * HOUR, -16.5 * HOUR)],
			});
			const r = await requestUpgrade(
				t.db,
				"m1",
				request({ durationMinutes: 31 }),
				NOW,
			);

			expect(r.status).toBe(403);
			expect(String(r.body.error)).toMatch(/cap of 24 h.*Limits panel/);
			expect(resize).not.toHaveBeenCalled();
			const anomalies = t.data.missionAnomalies.filter(
				(a) => a.category === "upgrade-cap-reached",
			);
			expect(anomalies).toHaveLength(1);
			expect(anomalies[0]).toMatchObject({ missionId: "m1", severity: "hard" });
			// relayed to the owner's control-plane copilot
			expect(
				t.data.mailbox.some(
					(d) =>
						d.missionId === "copilot-u1" &&
						Array.isArray(d.to) &&
						d.to.includes("copilot"),
				),
			).toBe(true);
		});

		it("does not raise the anomaly again for the same mission within 24 h", async () => {
			const t = setup(undefined, {
				machineSegments: [upgradedSegment(-40 * HOUR, -16 * HOUR)],
			});
			await requestUpgrade(t.db, "m1", request(), NOW);
			await requestUpgrade(t.db, "m1", request(), at(MIN));
			expect(
				t.data.missionAnomalies.filter(
					(a) => a.category === "upgrade-cap-reached",
				),
			).toHaveLength(1);
		});

		it("does not count time before the operator's last reset", async () => {
			const t = setup(missionDoc({ upgradedRuntimeResetAt: at(-1 * HOUR) }), {
				machineSegments: [upgradedSegment(-40 * HOUR, -16 * HOUR)],
			});
			expect((await requestUpgrade(t.db, "m1", request(), NOW)).status).toBe(
				200,
			);
		});

		it("counts an active window as elapsed, not committed, when changing shape", async () => {
			// 23 h closed + 50 min elapsed in the open window = 23.83 h; +10 min is fine
			const t = setup(missionDoc({ upgrade: upgradeState() }), {
				machineSegments: [
					upgradedSegment(-30 * HOUR, -7 * HOUR),
					upgradedSegment(-50 * MIN, null, { plannedEndAt: at(10 * MIN) }),
				],
			});
			const r = await requestUpgrade(
				t.db,
				"m1",
				request({ ...OTHER, durationMinutes: 10 }),
				NOW,
			);
			expect(r.status).toBe(200);
		});
	});

	describe("failures", () => {
		it("leaves everything unchanged when the machine will not stop", async () => {
			resize.mockRejectedValue(new ResizeError("stop", "Fly is down"));
			const t = setup();
			const r = await requestUpgrade(t.db, "m1", request(), NOW);

			expect(r.status).toBe(502);
			expect(String(r.body.error)).toMatch(/Nothing changed/);
			const m = t.mission();
			expect(m).toMatchObject({ status: "running", machineId: "mach-1" });
			expect(m.upgrade).toBeUndefined();
			expect(m.resize?.claimedAt).toBeUndefined();
			expect(t.data.scheduled_messages).toHaveLength(0);
			expect(t.data.missionAnomalies).toHaveLength(0);
		});

		it("puts the mission in error, raises resize-failure and tells the operator to Resume when the re-create fails", async () => {
			resize.mockRejectedValue(new ResizeError("provision", "no capacity"));
			const t = setup(undefined, {
				machineSegments: [upgradedSegment(-MIN, null)],
			});
			const r = await requestUpgrade(t.db, "m1", request(), NOW);

			expect(r.status).toBe(500);
			const m = t.mission();
			expect(m.status).toBe("error");
			expect(String(m.errorMessage)).toMatch(/provision step.*Resume/);
			expect(m.upgrade).toBeUndefined();
			expect(m.resize?.claimedAt).toBeUndefined();
			expect(
				t.data.missionAnomalies.some(
					(a) => a.category === "resize-failure" && a.severity === "hard",
				),
			).toBe(true);
			expect(t.mail("Machine resize failed")).toHaveLength(1);
			expect(t.data.machineSegments.every((s) => s.endedAt !== undefined)).toBe(
				true,
			);
		});
	});

	describe("changing shape while already upgraded", () => {
		it("replaces the reminder and resizes again", async () => {
			const oldReminder = new ObjectId();
			const t = setup(
				missionDoc({
					upgrade: upgradeState({ reminderId: oldReminder.toHexString() }),
				}),
				{
					scheduled_messages: [
						{ _id: oldReminder, missionId: "m1", status: "pending" },
					],
				},
			);
			const r = await requestUpgrade(t.db, "m1", request({ ...OTHER }), NOW);

			expect(r.status).toBe(200);
			expect(resize).toHaveBeenCalledTimes(1);
			expect(t.data.scheduled_messages).toHaveLength(1);
			expect(t.data.scheduled_messages[0]._id).not.toEqual(oldReminder);
			expect(t.mission().upgrade).toMatchObject({ ...OTHER });
		});
	});
});

describe("requestUpgrade — renewal (same shape)", () => {
	function renewable(over: Doc = {}, extra: Record<string, Doc[]> = {}) {
		const oldReminder = new ObjectId();
		const t = setup(
			missionDoc({
				upgrade: upgradeState({ reminderId: oldReminder.toHexString() }),
				...over,
			}),
			{
				machineSegments: [
					upgradedSegment(-50 * MIN, null, { plannedEndAt: at(10 * MIN) }),
				],
				scheduled_messages: [
					{ _id: oldReminder, missionId: "m1", status: "pending" },
				],
				...extra,
			},
		);
		return { t, oldReminder };
	}

	it("extends the expiry without restarting anything, and replaces the reminder", async () => {
		const { t, oldReminder } = renewable();
		const r = await requestUpgrade(
			t.db,
			"m1",
			request({ durationMinutes: 45 }),
			NOW,
		);

		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ action: "renewed" });
		expect(resize).not.toHaveBeenCalled();
		expect(t.mission().upgrade?.expiresAt).toEqual(at(45 * MIN));
		expect(t.data.machineSegments[0].plannedEndAt).toEqual(at(45 * MIN));
		expect(t.data.scheduled_messages).toHaveLength(1);
		expect(t.data.scheduled_messages[0]._id).not.toEqual(oldReminder);
		expect(t.mission().upgrade?.reminderId).toBe(
			(t.data.scheduled_messages[0]._id as ObjectId).toHexString(),
		);
		expect(String(t.mail("Machine upgrade renewed")[0].body)).toMatch(
			/no restart/,
		);
	});

	it("is exempt from the cooldown", async () => {
		const { t } = renewable({ resize: { lastAt: at(-MIN) } });
		expect((await requestUpgrade(t.db, "m1", request(), NOW)).status).toBe(200);
	});

	it("renews an upgrade whose window has passed but has not been swept yet", async () => {
		const { t } = renewable({
			upgrade: upgradeState({ expiresAt: at(-2 * MIN) }),
		});
		const r = await requestUpgrade(t.db, "m1", request(), NOW);
		expect(r.status).toBe(200);
		expect(t.mission().upgrade?.expiresAt).toEqual(at(30 * MIN));
	});

	it("only counts the change to the planned end against the cap", async () => {
		// 22 h closed + 1 h committed for the open window = 23 h; renewing to +60 min adds 50 min.
		const { t } = renewable(
			{},
			{
				machineSegments: [
					upgradedSegment(-30 * HOUR, -8 * HOUR),
					upgradedSegment(-50 * MIN, null, { plannedEndAt: at(10 * MIN) }),
				],
			},
		);
		expect(
			(await requestUpgrade(t.db, "m1", request({ durationMinutes: 60 }), NOW))
				.status,
		).toBe(200);
	});

	it("rejects a renewal that would pass the cap", async () => {
		const { t } = renewable(
			{},
			{
				machineSegments: [
					upgradedSegment(-30 * HOUR, -7.5 * HOUR),
					upgradedSegment(-50 * MIN, null, { plannedEndAt: at(10 * MIN) }),
				],
			},
		);
		const r = await requestUpgrade(
			t.db,
			"m1",
			request({ durationMinutes: 60 }),
			NOW,
		);
		expect(r.status).toBe(403);
		expect(t.mission().upgrade?.expiresAt).toEqual(at(10 * MIN));
	});

	it("does not resurrect an upgrade that another resize is ending", async () => {
		const { t } = renewable({ resize: { claimedAt: at(-MIN) } });
		const r = await requestUpgrade(t.db, "m1", request(), NOW);
		expect(r.status).toBe(409);
		expect(t.mission().upgrade?.expiresAt).toEqual(at(10 * MIN));
	});
});

describe("revertUpgrade", () => {
	function upgraded(over: Doc = {}) {
		const reminder = new ObjectId();
		return setup(
			missionDoc({
				upgrade: upgradeState({ reminderId: reminder.toHexString() }),
				...over,
			}),
			{
				scheduled_messages: [
					{ _id: reminder, missionId: "m1", status: "pending" },
				],
			},
		);
	}

	it("returns to the mission's default machine, cancels the reminder and tells the requester", async () => {
		const t = upgraded({ mission: { memoryMb: 2048, cpus: 1 } });
		const r = await revertUpgrade(t.db, "m1", { reason: "expired", now: NOW });

		expect(r.status).toBe(200);
		expect(resize).toHaveBeenCalledWith(
			t.db,
			{ missionId: "m1", machineId: "mach-1", volumeId: "vol-1" },
			{ cpuKind: "shared", cpus: 1, memoryMb: 2048 },
			{ upgraded: false },
		);
		const m = t.mission();
		expect(m.upgrade).toBeUndefined();
		expect(m).toMatchObject({ machineId: "mach-2", status: "running" });
		expect(m.resize?.lastAt).toEqual(NOW);
		expect(m.resize?.claimedAt).toBeUndefined();
		expect(t.data.scheduled_messages).toHaveLength(0);
		const note = t.mail("Machine returned to the default")[0];
		expect(note.to).toEqual(["user", "mission-copilot", "analyst"]);
		expect(String(note.body)).toContain("window ended");
	});

	it("404s an unknown mission and 409s one that is not upgraded", async () => {
		expect(
			(await revertUpgrade(setup(null).db, "m1", { reason: "expired" })).status,
		).toBe(404);
		expect(
			(await revertUpgrade(setup().db, "m1", { reason: "expired" })).status,
		).toBe(409);
	});

	it("applies the cooldown to a requested revert but not to expiry or suspend", async () => {
		const recent = { resize: { lastAt: at(-MIN) } };
		expect(
			(
				await revertUpgrade(upgraded(recent).db, "m1", {
					reason: "requested",
					now: NOW,
				})
			).status,
		).toBe(429);
		expect(
			(
				await revertUpgrade(upgraded(recent).db, "m1", {
					reason: "expired",
					now: NOW,
				})
			).status,
		).toBe(200);
		expect(
			(
				await revertUpgrade(upgraded(recent).db, "m1", {
					reason: "suspend",
					now: NOW,
				})
			).status,
		).toBe(200);
	});

	it("puts the mission in error when the re-create fails", async () => {
		resize.mockRejectedValue(new ResizeError("delete", "Fly refused"));
		const t = upgraded();
		const r = await revertUpgrade(t.db, "m1", { reason: "expired", now: NOW });
		expect(r.status).toBe(500);
		expect(t.mission().status).toBe("error");
		expect(t.mission().upgrade).toBeUndefined();
		expect(t.data.scheduled_messages).toHaveLength(0);
	});
});

describe("sweepUpgrades", () => {
	it("reverts expired upgrades only", async () => {
		const t = setup(null, {
			missions: [
				missionDoc({ upgrade: upgradeState({ expiresAt: at(-MIN) }) }),
				missionDoc({
					missionId: "m2",
					upgrade: upgradeState({ expiresAt: at(20 * MIN) }),
				}),
				missionDoc({
					missionId: "m3",
					upgrade: upgradeState({ expiresAt: at(-MIN) }),
					resize: { claimedAt: at(-MIN) },
				}),
			],
		});
		const r = await sweepUpgrades(t.db, NOW);
		expect(r.reverted).toBe(1);
		expect(resize).toHaveBeenCalledTimes(1);
		expect(
			t.data.missions.find((m) => m.missionId === "m1")?.upgrade,
		).toBeUndefined();
		expect(
			t.data.missions.find((m) => m.missionId === "m2")?.upgrade,
		).toBeDefined();
	});

	it("recovers a resize that died mid-flight, leaving a fresh claim alone", async () => {
		const t = setup(null, {
			missions: [
				missionDoc({ resize: { claimedAt: at(-6 * MIN) } }),
				missionDoc({ missionId: "m2", resize: { claimedAt: at(-MIN) } }),
			],
		});
		const r = await sweepUpgrades(t.db, NOW);
		expect(r.recovered).toBe(1);
		const [m1, m2] = t.data.missions;
		expect(m1.status).toBe("error");
		expect((m1.resize as Doc).claimedAt).toBeUndefined();
		expect(
			t.data.missionAnomalies.some((a) => a.category === "resize-failure"),
		).toBe(true);
		expect(m2.status).toBe("running");
	});

	it("clears upgrade state left on a mission that is no longer running", async () => {
		const reminder = new ObjectId();
		const t = setup(
			missionDoc({
				status: "suspended",
				upgrade: upgradeState({ reminderId: reminder.toHexString() }),
			}),
			{
				machineSegments: [upgradedSegment(-HOUR, null)],
				scheduled_messages: [{ _id: reminder, missionId: "m1" }],
			},
		);
		const r = await sweepUpgrades(t.db, NOW);
		expect(r.cleared).toBe(1);
		expect(t.mission().upgrade).toBeUndefined();
		expect(t.data.machineSegments[0].endedAt).toEqual(NOW);
		expect(t.data.scheduled_messages).toHaveLength(0);
	});

	it("keeps sweeping the other missions when one fails", async () => {
		resize.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({
			machineId: "mach-9",
			privateIp: "::9",
			volumeId: "vol-1",
		});
		const t = setup(null, {
			missions: [
				missionDoc({
					missionId: "a",
					upgrade: upgradeState({ expiresAt: at(-MIN) }),
				}),
				missionDoc({
					missionId: "b",
					upgrade: upgradeState({ expiresAt: at(-MIN) }),
				}),
			],
		});
		await sweepUpgrades(t.db, NOW);
		expect(resize).toHaveBeenCalledTimes(2);
	});

	it("does nothing when there is nothing to do", async () => {
		expect(await sweepUpgrades(setup().db, NOW)).toEqual({
			reverted: 0,
			recovered: 0,
			cleared: 0,
		});
	});
});

describe("suspendMissionMachine", () => {
	it("just stops a mission that is not upgraded", async () => {
		const t = setup();
		await suspendMissionMachine(t.db, {
			missionId: "m1",
			machineId: "mach-1",
		});
		expect(resize).not.toHaveBeenCalled();
		expect(suspend).toHaveBeenCalledWith(t.db, "m1", "mach-1");
	});

	it("reverts an upgraded mission first, then stops the re-created default machine", async () => {
		const t = setup(missionDoc({ upgrade: upgradeState() }));
		await suspendMissionMachine(t.db, {
			missionId: "m1",
			machineId: "mach-1",
		});
		expect(resize).toHaveBeenCalledTimes(1);
		expect(suspend).toHaveBeenCalledWith(t.db, "m1", "mach-2");
		expect(t.mission().upgrade).toBeUndefined();
	});

	it("does not stop anything if the revert fails", async () => {
		resize.mockRejectedValue(new ResizeError("stop", "Fly is down"));
		const t = setup(missionDoc({ upgrade: upgradeState() }));
		await expect(
			suspendMissionMachine(t.db, { missionId: "m1", machineId: "mach-1" }),
		).rejects.toThrow(/default machine before suspending/);
		expect(suspend).not.toHaveBeenCalled();
	});
});
