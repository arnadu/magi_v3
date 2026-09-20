/**
 * Machine runtime segments (ADR-0031 Decision 1/7): the pure summaries, the
 * persistence helpers over an in-memory fake, and reconciliation with live
 * Fly state.
 */

import { describe, expect, it } from "vitest";
import {
	closeOpenSegments,
	defaultShapeOf,
	listSegments,
	type MachineSegment,
	openSegment,
	reconcileSegments,
	runtimeByConfig,
	setPlannedEnd,
	upgradedMs,
	upgradedMsSince,
} from "../src/machine-segments.js";
import type { MachineShape } from "../src/machine-shapes.js";
import { fakeSegmentsDb } from "./support/fake-segments-db.js";

const HOUR = 3_600_000;
/** Hours after a fixed origin. */
const at = (h: number) => new Date(Date.UTC(2026, 8, 20) + h * HOUR);

const DEFAULT: MachineShape = { cpuKind: "shared", cpus: 1, memoryMb: 1024 };
const BIG: MachineShape = { cpuKind: "performance", cpus: 2, memoryMb: 8192 };

function seg(
	startH: number,
	endH: number | undefined,
	over: Partial<MachineSegment> = {},
): MachineSegment {
	return {
		missionId: "m1",
		shape: DEFAULT,
		upgraded: false,
		startedAt: at(startH),
		...(endH === undefined ? {} : { endedAt: at(endH) }),
		...over,
	};
}
const up = (
	startH: number,
	endH: number | undefined,
	o: Partial<MachineSegment> = {},
) => seg(startH, endH, { shape: BIG, upgraded: true, ...o });

describe("defaultShapeOf", () => {
	it("is shared CPU sized by the mission's memoryMb/cpus, else the platform default", () => {
		expect(defaultShapeOf({})).toEqual(DEFAULT);
		expect(defaultShapeOf({ mission: { memoryMb: 2048, cpus: 2 } })).toEqual({
			cpuKind: "shared",
			cpus: 2,
			memoryMb: 2048,
		});
	});
});

describe("upgradedMs", () => {
	const opts = (mode: "elapsed" | "committed", now = 10, since = 0) => ({
		since: at(since),
		now: at(now),
		mode,
	});

	it("counts only upgraded segments", () => {
		expect(upgradedMs([seg(0, 5), up(5, 6)], opts("elapsed"))).toBe(HOUR);
	});

	it("clips a segment that straddles `since` (an operator reset)", () => {
		expect(upgradedMs([up(2, 6)], opts("elapsed", 10, 4))).toBe(2 * HOUR);
	});

	it("ignores a segment that ended before `since`", () => {
		expect(upgradedMs([up(1, 2)], opts("elapsed", 10, 3))).toBe(0);
	});

	it("counts an open segment up to now when displaying (elapsed)", () => {
		expect(
			upgradedMs([up(8, undefined, { plannedEndAt: at(12) })], opts("elapsed")),
		).toBe(2 * HOUR);
	});

	it("counts an open segment to its planned end when enforcing (committed)", () => {
		expect(
			upgradedMs(
				[up(8, undefined, { plannedEndAt: at(12) })],
				opts("committed"),
			),
		).toBe(4 * HOUR);
	});

	it("uses now when the planned end has already passed or is absent", () => {
		expect(
			upgradedMs(
				[up(8, undefined, { plannedEndAt: at(9) })],
				opts("committed"),
			),
		).toBe(2 * HOUR);
		expect(upgradedMs([up(8, undefined)], opts("committed"))).toBe(2 * HOUR);
	});

	it("gives back unused time when an upgrade ends early", () => {
		const planned = { plannedEndAt: at(12) };
		expect(upgradedMs([up(8, undefined, planned)], opts("committed"))).toBe(
			4 * HOUR,
		);
		expect(upgradedMs([up(8, 9, planned)], opts("committed"))).toBe(HOUR);
	});

	it("sums several segments", () => {
		expect(
			upgradedMs([up(0, 1), up(2, 3.5), up(9, undefined)], opts("elapsed")),
		).toBe(3.5 * HOUR);
	});
});

describe("runtimeByConfig", () => {
	it("groups by shape, most runtime first, open segments counted to now", () => {
		const result = runtimeByConfig(
			[seg(0, 4), up(4, 5), seg(5, 7), up(7, undefined)],
			{ since: at(0), now: at(10) },
		);
		expect(result).toEqual([
			{ shape: DEFAULT, upgraded: false, ms: 6 * HOUR },
			{ shape: BIG, upgraded: true, ms: 4 * HOUR },
		]);
	});

	it("respects the time window and drops empty groups", () => {
		const result = runtimeByConfig([seg(0, 2), up(2, 3)], {
			since: at(2.5),
			now: at(10),
		});
		expect(result).toEqual([{ shape: BIG, upgraded: true, ms: 0.5 * HOUR }]);
	});
});

describe("persistence", () => {
	it("openSegment closes an existing open segment first, so at most one is ever open", async () => {
		const { db, segments } = fakeSegmentsDb();
		await openSegment(db, { ...seg(0, undefined), machineId: "a" });
		await openSegment(db, { ...seg(3, undefined), machineId: "b" });

		expect(segments).toHaveLength(2);
		expect(segments[0].endedAt).toEqual(at(3));
		expect(segments[1].endedAt).toBeUndefined();
	});

	it("does not store undefined optional fields", async () => {
		const { db, segments } = fakeSegmentsDb();
		await openSegment(db, {
			missionId: "m1",
			shape: DEFAULT,
			upgraded: false,
			startedAt: at(0),
			plannedEndAt: undefined,
			requestedByAgentId: undefined,
		});
		expect(Object.keys(segments[0])).not.toContain("plannedEndAt");
		expect(Object.keys(segments[0])).not.toContain("requestedByAgentId");
	});

	it("closeOpenSegments closes only that mission's open segment and is idempotent", async () => {
		const { db, segments } = fakeSegmentsDb();
		await openSegment(db, seg(0, undefined));
		await openSegment(db, { ...seg(0, undefined), missionId: "m2" });

		expect(await closeOpenSegments(db, "m1", at(2))).toBe(1);
		expect(await closeOpenSegments(db, "m1", at(3))).toBe(0);
		expect(segments.find((s) => s.missionId === "m1")?.endedAt).toEqual(at(2));
		expect(segments.find((s) => s.missionId === "m2")?.endedAt).toBeUndefined();
	});

	it("setPlannedEnd moves the end of the open segment only", async () => {
		const { db, segments } = fakeSegmentsDb();
		await openSegment(db, up(0, undefined, { plannedEndAt: at(1) }));
		await setPlannedEnd(db, "m1", at(2));
		expect(segments[0].plannedEndAt).toEqual(at(2));
	});

	it("listSegments returns segments overlapping the window, oldest first", async () => {
		const { db, segments } = fakeSegmentsDb();
		segments.push(
			{ ...up(5, 6) },
			{ ...seg(0, 1) }, // ended before the window
			{ ...up(2, 4) },
			{ ...up(8, undefined) },
			{ ...up(3, 4), missionId: "other" },
		);
		const listed = await listSegments(db, "m1", at(1.5));
		expect(listed.map((s) => s.startedAt)).toEqual([at(2), at(5), at(8)]);
	});

	it("upgradedMsSince ties it together", async () => {
		const { db } = fakeSegmentsDb();
		await openSegment(db, up(0, undefined, { plannedEndAt: at(3) }));
		await closeOpenSegments(db, "m1", at(1));
		await openSegment(db, up(5, undefined, { plannedEndAt: at(9) }));
		expect(await upgradedMsSince(db, "m1", at(0), at(6), "elapsed")).toBe(
			2 * HOUR,
		);
		expect(await upgradedMsSince(db, "m1", at(0), at(6), "committed")).toBe(
			5 * HOUR,
		);
	});
});

describe("reconcileSegments", () => {
	const missionDoc = (id: string, machineId: string, mission = {}) => ({
		missionId: id,
		machineId,
		mission,
	});

	it("closes a segment whose machine is stopped or gone, keeps one whose machine runs", async () => {
		const { db, segments } = fakeSegmentsDb();
		await openSegment(db, {
			...seg(0, undefined),
			missionId: "a",
			machineId: "ma",
		});
		await openSegment(db, {
			...seg(0, undefined),
			missionId: "b",
			machineId: "mb",
		});
		await openSegment(db, {
			...seg(0, undefined),
			missionId: "c",
			machineId: "mc",
		});

		const r = await reconcileSegments(
			db,
			[
				{ id: "ma", state: "started" },
				{ id: "mb", state: "stopped" },
				// "mc" is not listed at all: destroyed
			],
			at(5),
		);

		expect(r).toEqual({ closed: 2, opened: 0 });
		const byMission = (m: string) => segments.find((s) => s.missionId === m);
		expect(byMission("a")?.endedAt).toBeUndefined();
		expect(byMission("b")?.endedAt).toEqual(at(5));
		expect(byMission("c")?.endedAt).toEqual(at(5));
	});

	it("opens a segment with Fly's real shape for a running machine that has none", async () => {
		const { db, segments } = fakeSegmentsDb({
			missions: [missionDoc("m1", "mx")],
		});
		const r = await reconcileSegments(
			db,
			[
				{
					id: "mx",
					state: "started",
					guest: { cpu_kind: "performance", cpus: 2, memory_mb: 8192 },
				},
			],
			at(5),
		);
		expect(r).toEqual({ closed: 0, opened: 1 });
		expect(segments[0]).toMatchObject({
			missionId: "m1",
			machineId: "mx",
			shape: BIG,
			upgraded: true,
			startedAt: at(5),
		});
	});

	it("marks a machine on the mission's default shape as not upgraded", async () => {
		const { db, segments } = fakeSegmentsDb({
			missions: [missionDoc("m1", "mx", { memoryMb: 2048 })],
		});
		await reconcileSegments(
			db,
			[
				{
					id: "mx",
					state: "started",
					guest: { cpu_kind: "shared", cpus: 1, memory_mb: 2048 },
				},
			],
			at(5),
		);
		expect(segments[0].upgraded).toBe(false);
	});

	it("does not open a second segment when one is already open, or for machines with no mission", async () => {
		const { db, segments } = fakeSegmentsDb({
			missions: [missionDoc("m1", "mx")],
		});
		await openSegment(db, { ...seg(0, undefined), machineId: "mx" });
		const r = await reconcileSegments(
			db,
			[
				{ id: "mx", state: "started" },
				{ id: "orphan", state: "started" },
			],
			at(5),
		);
		expect(r).toEqual({ closed: 0, opened: 0 });
		expect(segments).toHaveLength(1);
	});

	it("opens a segment when a stale one is closed and the machine is in fact running under a new id", async () => {
		const { db, segments } = fakeSegmentsDb({
			missions: [missionDoc("m1", "new-machine")],
		});
		await openSegment(db, { ...seg(0, undefined), machineId: "old-machine" });
		const r = await reconcileSegments(
			db,
			[{ id: "new-machine", state: "started" }],
			at(5),
		);
		expect(r).toEqual({ closed: 1, opened: 1 });
		const open = segments.filter((s) => s.endedAt === undefined);
		expect(open).toHaveLength(1);
		expect(open[0].machineId).toBe("new-machine");
	});
});
