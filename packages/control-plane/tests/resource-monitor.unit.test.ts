/**
 * The 5-min resource-monitor tick (ADR-0032): per-mission alert categories
 * (spend-cap-near, spend-spike, upgrade-cap-near, upgrade-idle) plus the
 * cross-cutting Atlas/OOM checks. Mongo is the shared in-memory fake, and the
 * alert store is the real `createMongoAlertStateStore` running against it —
 * the Atlas check itself is exercised only for "it never breaks the tick,"
 * its own logic is covered by atlas-usage.unit.test.ts.
 */

import { createMongoAlertStateStore } from "@magi/agent-runtime-worker";
import type { MongoClient } from "mongodb";
import { describe, expect, it } from "vitest";
import {
	checkMission,
	type MissionRow,
	runResourceMonitorTick,
} from "../src/resource-monitor.js";
import { type Doc, fakeDb } from "./support/fake-db.js";

const NOW = new Date("2026-09-22T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function setup(over: Record<string, Doc[]> = {}) {
	const { db, data } = fakeDb({
		missions: [],
		missionStats: [],
		agentTurnStats: [],
		missionResources: [],
		machineSegments: [],
		missionAnomalies: [],
		mailbox: [],
		resourceAlertState: [],
		...over,
	});
	return { db, data, alertStore: createMongoAlertStateStore(db) };
}

const missionRow = (over: Partial<MissionRow> = {}): MissionRow => ({
	missionId: "m1",
	userId: "u1",
	...over,
});

describe("checkMission > spend-cap-near", () => {
	it("does nothing when no cap is configured", async () => {
		const { db, data, alertStore } = setup({
			missionStats: [{ missionId: "m1", agentId: "a1", lifetimeCostUsd: 1000 }],
		});
		await checkMission(db, missionRow(), alertStore, NOW);
		expect(data.missionAnomalies).toHaveLength(0);
	});

	it("raises soft at 90% of the cap", async () => {
		const { db, data, alertStore } = setup({
			missionStats: [{ missionId: "m1", agentId: "a1", lifetimeCostUsd: 90 }],
		});
		await checkMission(
			db,
			missionRow({ mission: { maxCostUsd: 100 } }),
			alertStore,
			NOW,
		);
		expect(
			data.missionAnomalies.some(
				(a) => a.category === "spend-cap-near" && a.severity === "soft",
			),
		).toBe(true);
	});

	it("raises hard at 98% of the cap and relays to the copilot mailbox", async () => {
		const { db, data, alertStore } = setup({
			missionStats: [{ missionId: "m1", agentId: "a1", lifetimeCostUsd: 98 }],
		});
		await checkMission(
			db,
			missionRow({ mission: { maxCostUsd: 100 } }),
			alertStore,
			NOW,
		);
		expect(
			data.missionAnomalies.some(
				(a) => a.category === "spend-cap-near" && a.severity === "hard",
			),
		).toBe(true);
		expect(data.mailbox.some((m) => m.missionId === "copilot-u1")).toBe(true);
	});

	it("sums lifetime cost across every agent, plus any in-flight turn cost", async () => {
		const { db, data, alertStore } = setup({
			missionStats: [
				{ missionId: "m1", agentId: "a1", lifetimeCostUsd: 40 },
				{ missionId: "m1", agentId: "a2", lifetimeCostUsd: 40 },
			],
			agentTurnStats: [
				{
					missionId: "m1",
					agentId: "a2",
					turnNumber: 1,
					status: "running",
					costUsd: 15,
					startedAt: NOW,
				},
			],
		});
		// total = 40 + 40 + 15 = 95 -> 95% of 100 -> soft (>= 90%, < 98%)
		await checkMission(
			db,
			missionRow({ mission: { maxCostUsd: 100 } }),
			alertStore,
			NOW,
		);
		const hit = data.missionAnomalies.find(
			(a) => a.category === "spend-cap-near",
		);
		expect(hit).toBeDefined();
		expect(hit?.message).toContain("95%");
	});

	it("does not re-alert on the very next tick at the same level (24h repeat window)", async () => {
		const { db, data, alertStore } = setup({
			missionStats: [{ missionId: "m1", agentId: "a1", lifetimeCostUsd: 90 }],
		});
		const mission = missionRow({ mission: { maxCostUsd: 100 } });
		await checkMission(db, mission, alertStore, NOW);
		await checkMission(
			db,
			mission,
			alertStore,
			new Date(NOW.getTime() + 5 * 60_000),
		);
		expect(
			data.missionAnomalies.filter((a) => a.category === "spend-cap-near"),
		).toHaveLength(1);
	});
});

describe("checkMission > spend-spike", () => {
	function turnDoc(daysAgo: number, costUsd: number, agentId = "a1"): Doc {
		return {
			missionId: "m1",
			agentId,
			turnNumber: Math.round(daysAgo * 100),
			status: "complete",
			costUsd,
			startedAt: new Date(NOW.getTime() - daysAgo * DAY),
		};
	}

	it("does not fire below the $5 minimum even with no baseline", async () => {
		const { db, data, alertStore } = setup({
			agentTurnStats: [turnDoc(0.1, 4)],
		});
		await checkMission(db, missionRow(), alertStore, NOW);
		expect(data.missionAnomalies).toHaveLength(0);
	});

	it("fires soft when 24h spend exceeds 3x the trailing 7-day daily average", async () => {
		// Baseline: $7/day for 7 days = $49 total in [8d ago, 1d ago).
		// Last 24h: $30 (> 3 * 7 = 21, and > $5 minimum).
		const baseline = Array.from({ length: 7 }, (_, i) => turnDoc(1 + i, 7));
		const { db, data, alertStore } = setup({
			agentTurnStats: [...baseline, turnDoc(0.1, 30)],
		});
		await checkMission(db, missionRow(), alertStore, NOW);
		const hit = data.missionAnomalies.find((a) => a.category === "spend-spike");
		expect(hit).toBeDefined();
		expect(hit?.severity).toBe("soft");
	});

	it("does not fire when 24h spend stays within 3x the baseline", async () => {
		const baseline = Array.from({ length: 7 }, (_, i) => turnDoc(1 + i, 7));
		const { db, data, alertStore } = setup({
			agentTurnStats: [...baseline, turnDoc(0.1, 10)],
		});
		await checkMission(db, missionRow(), alertStore, NOW);
		expect(data.missionAnomalies).toHaveLength(0);
	});
});

describe("checkMission > upgrade-cap-near", () => {
	it("does nothing with no upgraded segments", async () => {
		const { db, data, alertStore } = setup();
		await checkMission(db, missionRow(), alertStore, NOW);
		expect(data.missionAnomalies).toHaveLength(0);
	});

	it("fires soft at 80% of the 24h cumulative cap", async () => {
		const { db, data, alertStore } = setup({
			machineSegments: [
				{
					missionId: "m1",
					shape: { cpuKind: "shared", cpus: 2, memoryMb: 4096 },
					upgraded: true,
					startedAt: new Date(NOW.getTime() - 20 * HOUR), // 20h of 24h cap = 83%
				},
			],
		});
		await checkMission(db, missionRow(), alertStore, NOW);
		const hit = data.missionAnomalies.find(
			(a) => a.category === "upgrade-cap-near",
		);
		expect(hit).toBeDefined();
		expect(hit?.severity).toBe("soft");
	});

	it("respects upgradedRuntimeResetAt — only counts time since the last operator reset", async () => {
		const resetAt = new Date(NOW.getTime() - 1 * HOUR);
		const { db, data, alertStore } = setup({
			machineSegments: [
				{
					missionId: "m1",
					shape: { cpuKind: "shared", cpus: 2, memoryMb: 4096 },
					upgraded: true,
					startedAt: new Date(NOW.getTime() - 20 * HOUR), // mostly before the reset
				},
			],
		});
		await checkMission(
			db,
			missionRow({ upgradedRuntimeResetAt: resetAt }),
			alertStore,
			NOW,
		);
		// Only the 1h since reset counts -> 1/24 ~= 4%, well below the 80% threshold.
		expect(data.missionAnomalies).toHaveLength(0);
	});
});

describe("checkMission > upgrade-idle", () => {
	it("does nothing when the mission is not currently upgraded", async () => {
		const { db, data, alertStore } = setup({
			missionStats: [
				{
					missionId: "m1",
					agentId: "a1",
					lastTurnAt: new Date(NOW.getTime() - 2 * HOUR),
				},
			],
			missionResources: [{ missionId: "m1", runningJobs: 0 }],
		});
		await checkMission(db, missionRow(), alertStore, NOW);
		expect(data.missionAnomalies).toHaveLength(0);
	});

	it("does nothing when a job is still running", async () => {
		const { db, data, alertStore } = setup({
			missionStats: [
				{
					missionId: "m1",
					agentId: "a1",
					lastTurnAt: new Date(NOW.getTime() - 2 * HOUR),
				},
			],
			missionResources: [{ missionId: "m1", runningJobs: 1 }],
		});
		await checkMission(
			db,
			missionRow({
				upgrade: { cpuKind: "shared", cpus: 2, memoryMb: 4096, expiresAt: NOW },
			}),
			alertStore,
			NOW,
		);
		expect(data.missionAnomalies).toHaveLength(0);
	});

	it("fires soft when upgraded, idle past 30 min, and no running job", async () => {
		const { db, data, alertStore } = setup({
			missionStats: [
				{
					missionId: "m1",
					agentId: "a1",
					lastTurnAt: new Date(NOW.getTime() - 45 * 60_000),
				},
			],
			missionResources: [{ missionId: "m1", runningJobs: 0 }],
		});
		await checkMission(
			db,
			missionRow({
				upgrade: { cpuKind: "shared", cpus: 2, memoryMb: 4096, expiresAt: NOW },
			}),
			alertStore,
			NOW,
		);
		const hit = data.missionAnomalies.find(
			(a) => a.category === "upgrade-idle",
		);
		expect(hit).toBeDefined();
		expect(hit?.severity).toBe("soft");
	});

	it("does not fire when there is no missionResources sample (never guesses idle)", async () => {
		const { db, data, alertStore } = setup({
			missionStats: [
				{
					missionId: "m1",
					agentId: "a1",
					lastTurnAt: new Date(NOW.getTime() - 2 * HOUR),
				},
			],
		});
		await checkMission(
			db,
			missionRow({
				upgrade: { cpuKind: "shared", cpus: 2, memoryMb: 4096, expiresAt: NOW },
			}),
			alertStore,
			NOW,
		);
		expect(data.missionAnomalies).toHaveLength(0);
	});
});

describe("runResourceMonitorTick", () => {
	function fakeMongoClient(): MongoClient {
		return {
			db: () => ({
				admin: () => ({
					listDatabases: async () => {
						throw new Error("no cluster in this test");
					},
				}),
				collection: () => ({
					listCollections: () => ({ toArray: async () => [] }),
				}),
			}),
		} as unknown as MongoClient;
	}

	it("checks every running mission and skips non-running ones", async () => {
		const { db, data } = setup({
			missions: [
				{
					missionId: "m1",
					userId: "u1",
					status: "running",
					mission: { maxCostUsd: 100 },
				},
				{
					missionId: "m2",
					userId: "u2",
					status: "suspended",
					mission: { maxCostUsd: 100 },
				},
			],
			missionStats: [
				{ missionId: "m1", agentId: "a1", lifetimeCostUsd: 99 },
				{ missionId: "m2", agentId: "a1", lifetimeCostUsd: 99 },
			],
		});
		await runResourceMonitorTick(db, fakeMongoClient(), {
			platformAdminUserIds: [],
			now: () => NOW,
		});
		const missionIds = data.missionAnomalies.map((a) => a.missionId);
		expect(missionIds).toContain("m1");
		expect(missionIds).not.toContain("m2");
	});

	it("a broken Mongo client (Atlas check) never stops the per-mission checks", async () => {
		const { db, data } = setup({
			missions: [
				{
					missionId: "m1",
					userId: "u1",
					status: "running",
					mission: { maxCostUsd: 100 },
				},
			],
			missionStats: [{ missionId: "m1", agentId: "a1", lifetimeCostUsd: 99 }],
		});
		const brokenClient = {
			db: () => {
				throw new Error("client down");
			},
		} as unknown as MongoClient;
		await expect(
			runResourceMonitorTick(db, brokenClient, {
				platformAdminUserIds: [],
				now: () => NOW,
			}),
		).resolves.toBeUndefined();
		expect(
			data.missionAnomalies.some((a) => a.category === "spend-cap-near"),
		).toBe(true);
	});

	it("one mission with nothing to alert on never stops the rest of the tick", async () => {
		const { db, data } = setup({
			missions: [
				{ missionId: "m1", userId: "u1", status: "running" },
				{
					missionId: "m2",
					userId: "u2",
					status: "running",
					mission: { maxCostUsd: 100 },
				},
			],
			missionStats: [{ missionId: "m2", agentId: "a1", lifetimeCostUsd: 99 }],
		});
		await runResourceMonitorTick(db, fakeMongoClient(), {
			platformAdminUserIds: [],
			now: () => NOW,
		});
		expect(
			data.missionAnomalies.some(
				(a) => a.missionId === "m2" && a.category === "spend-cap-near",
			),
		).toBe(true);
	});

	it("F-028 regression: user A's breach never relays to user B's copilot mailbox", async () => {
		const { db, data } = setup({
			missions: [
				{
					missionId: "m1",
					userId: "u1",
					status: "running",
					mission: { maxCostUsd: 100 },
				},
				{
					missionId: "m2",
					userId: "u2",
					status: "running",
					mission: { maxCostUsd: 100 },
				},
			],
			missionStats: [
				{ missionId: "m1", agentId: "a1", lifetimeCostUsd: 99 },
				{ missionId: "m2", agentId: "a1", lifetimeCostUsd: 99 },
			],
		});
		await runResourceMonitorTick(db, fakeMongoClient(), {
			platformAdminUserIds: [],
			now: () => NOW,
		});

		const u1Mail = data.mailbox.filter((m) => m.missionId === "copilot-u1");
		const u2Mail = data.mailbox.filter((m) => m.missionId === "copilot-u2");
		expect(u1Mail.length).toBeGreaterThan(0);
		expect(u2Mail.length).toBeGreaterThan(0);
		expect(u1Mail.every((m) => (m.body as string).includes("m1"))).toBe(true);
		expect(u1Mail.every((m) => !(m.body as string).includes("m2"))).toBe(true);
		expect(u2Mail.every((m) => (m.body as string).includes("m2"))).toBe(true);
		expect(u2Mail.every((m) => !(m.body as string).includes("m1"))).toBe(true);
	});
});
