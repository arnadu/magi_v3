/**
 * Shared Mongo reads behind the resource-monitor tick and the daily report.
 * Thin wrappers over the shared in-memory fake — the interesting logic lives
 * in the callers, already covered by resource-monitor.unit.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
	lastActivityAt,
	latestResourceSample,
	sumTurnCostUsd,
} from "../src/resource-queries.js";
import { fakeDb } from "./support/fake-db.js";

describe("sumTurnCostUsd", () => {
	it("sums costUsd for turns within the window, across every agent", async () => {
		const { db } = fakeDb({
			agentTurnStats: [
				{
					missionId: "m1",
					agentId: "a1",
					costUsd: 3,
					startedAt: new Date("2026-09-22T10:00:00Z"),
				},
				{
					missionId: "m1",
					agentId: "a2",
					costUsd: 4,
					startedAt: new Date("2026-09-22T11:00:00Z"),
				},
				{
					missionId: "m1",
					agentId: "a1",
					costUsd: 100,
					startedAt: new Date("2026-09-20T00:00:00Z"),
				},
				{
					missionId: "m2",
					agentId: "a1",
					costUsd: 100,
					startedAt: new Date("2026-09-22T10:30:00Z"),
				},
			],
		});
		const total = await sumTurnCostUsd(
			db,
			"m1",
			new Date("2026-09-22T00:00:00Z"),
			new Date("2026-09-23T00:00:00Z"),
		);
		expect(total).toBe(7);
	});

	it("returns 0 with no matching turns", async () => {
		const { db } = fakeDb({ agentTurnStats: [] });
		const total = await sumTurnCostUsd(db, "m1", new Date(0), new Date());
		expect(total).toBe(0);
	});
});

describe("lastActivityAt", () => {
	it("returns the max lastTurnAt across every agent", async () => {
		const { db } = fakeDb({
			missionStats: [
				{
					missionId: "m1",
					agentId: "a1",
					lastTurnAt: new Date("2026-09-22T10:00:00Z"),
				},
				{
					missionId: "m1",
					agentId: "a2",
					lastTurnAt: new Date("2026-09-22T12:00:00Z"),
				},
			],
		});
		expect(await lastActivityAt(db, "m1")).toEqual(
			new Date("2026-09-22T12:00:00Z"),
		);
	});

	it("returns null when the mission has no missionStats docs", async () => {
		const { db } = fakeDb({ missionStats: [] });
		expect(await lastActivityAt(db, "m1")).toBeNull();
	});
});

describe("latestResourceSample", () => {
	it("returns the mission's sample", async () => {
		const { db } = fakeDb({
			missionResources: [
				{
					missionId: "m1",
					diskUsedBytes: 100,
					diskTotalBytes: 1000,
					runningJobs: 2,
				},
			],
		});
		expect(await latestResourceSample(db, "m1")).toMatchObject({
			diskUsedBytes: 100,
			diskTotalBytes: 1000,
			runningJobs: 2,
		});
	});

	it("returns null when no sample exists yet", async () => {
		const { db } = fakeDb({ missionResources: [] });
		expect(await latestResourceSample(db, "m1")).toBeNull();
	});
});
