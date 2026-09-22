/**
 * The daily resource report (ADR-0032 Decision 5). Report wording itself is
 * not asserted on beyond structure (CLAUDE.md: prompt/report content is
 * judged manually) — these tests check the underlying data assembly, the
 * flag thresholds, and the idempotency/catch-up scheduling, which are the
 * parts a bug would actually break silently.
 */

import { describe, expect, it } from "vitest";
import {
	buildDailyReport,
	renderDailyReport,
	runDailyReportsIfDue,
} from "../src/resource-report.js";
import { type Doc, fakeDb } from "./support/fake-db.js";

const NOW = new Date("2026-09-22T12:00:00.000Z"); // noon UTC — the default report hour
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
		resourceSnapshots: [],
		platformResources: [],
		...over,
	});
	return { db, data };
}

const missionDoc = (over: Doc = {}): Doc => ({
	missionId: "m1",
	userId: "u1",
	status: "running",
	...over,
});

describe("buildDailyReport", () => {
	it("includes only the user's own non-destroyed, non-draft missions", async () => {
		const { db } = setup({
			missions: [
				missionDoc({ missionId: "m1", userId: "u1", status: "running" }),
				missionDoc({ missionId: "m2", userId: "u1", status: "draft" }),
				missionDoc({ missionId: "m3", userId: "u1", status: "destroyed" }),
				missionDoc({ missionId: "m4", userId: "u2", status: "running" }),
			],
		});
		const report = await buildDailyReport(db, "u1", NOW);
		expect(report.missions.map((m) => m.missionId)).toEqual(["m1"]);
	});

	it("includes suspended missions (status and spend still shown)", async () => {
		const { db } = setup({
			missions: [missionDoc({ status: "suspended" })],
			missionStats: [{ missionId: "m1", agentId: "a1", lifetimeCostUsd: 12.5 }],
		});
		const report = await buildDailyReport(db, "u1", NOW);
		expect(report.missions[0]).toMatchObject({
			status: "suspended",
			llmTotalUsd: 12.5,
		});
	});

	it("handles a mission with no resource sample yet (undefined disk fields, not a crash)", async () => {
		const { db } = setup({ missions: [missionDoc()] });
		const report = await buildDailyReport(db, "u1", NOW);
		expect(report.missions[0].diskUsedBytes).toBeUndefined();
		expect(report.missions[0].diskSampleAt).toBeUndefined();
	});

	it("includes the Atlas block only for admins", async () => {
		const { db } = setup({
			missions: [missionDoc()],
			platformResources: [
				{
					_id: "atlas",
					usedBytes: 300 * 1024 * 1024,
					limitBytes: 512 * 1024 * 1024,
					databases: [],
					collections: [],
				},
			],
		});
		const nonAdmin = await buildDailyReport(db, "u1", NOW, { isAdmin: false });
		const admin = await buildDailyReport(db, "u1", NOW, { isAdmin: true });
		expect(nonAdmin.atlas).toBeUndefined();
		expect(admin.atlas).toBeDefined();
		expect(admin.atlas?.usedBytes).toBe(300 * 1024 * 1024);
	});
});

describe("computeFlags (via buildDailyReport)", () => {
	it("flags a mission at or above 80% disk usage", async () => {
		const { db } = setup({
			missions: [missionDoc()],
			missionResources: [
				{
					missionId: "m1",
					diskUsedBytes: 8.5e9,
					diskTotalBytes: 10e9,
					updatedAt: NOW,
				},
			],
		});
		const report = await buildDailyReport(db, "u1", NOW);
		expect(
			report.flags.some((f) => f.label === "Disk" && f.scope === "m1"),
		).toBe(true);
	});

	it("does not flag disk below 80% with no fast-growth projection", async () => {
		const { db } = setup({
			missions: [missionDoc()],
			missionResources: [
				{
					missionId: "m1",
					diskUsedBytes: 1e9,
					diskTotalBytes: 10e9,
					updatedAt: NOW,
				},
			],
		});
		const report = await buildDailyReport(db, "u1", NOW);
		expect(report.flags.some((f) => f.label === "Disk")).toBe(false);
	});

	it("flags disk below 80% when projected full within 7 days from yesterday's snapshot", async () => {
		const { db } = setup({
			missions: [missionDoc()],
			missionResources: [
				// 9.5 / 10 GB today; yesterday's snapshot (below) had 9.0 GB ->
				// growing 0.5 GB/day -> 1 GB left / 0.5 GB/day = 2 days to full.
				{
					missionId: "m1",
					diskUsedBytes: 9.5e9,
					diskTotalBytes: 10e9,
					updatedAt: NOW,
				},
			],
			resourceSnapshots: [
				{
					userId: "u1",
					date: "2026-09-21",
					generatedAt: new Date(NOW.getTime() - DAY),
					missions: {
						m1: { diskUsedBytes: 9.0e9, llmTotalUsd: 0, upgradedMs: 0 },
					},
				},
			],
		});
		const report = await buildDailyReport(db, "u1", NOW);
		const flag = report.flags.find((f) => f.label === "Disk");
		expect(flag).toBeDefined();
		expect(flag?.detail).toContain("full in");
	});

	it("flags Atlas storage at or above 70%, admin reports only", async () => {
		const { db } = setup({
			missions: [missionDoc()],
			platformResources: [
				{
					_id: "atlas",
					usedBytes: 400 * 1024 * 1024,
					limitBytes: 512 * 1024 * 1024,
					databases: [],
					collections: [],
				},
			],
		});
		const admin = await buildDailyReport(db, "u1", NOW, { isAdmin: true });
		expect(admin.flags.some((f) => f.label === "Atlas storage")).toBe(true);
		const nonAdmin = await buildDailyReport(db, "u1", NOW, { isAdmin: false });
		expect(nonAdmin.flags.some((f) => f.label === "Atlas storage")).toBe(false);
	});

	it("flags spend at or above 80% of the mission's cap", async () => {
		const { db } = setup({
			missions: [missionDoc({ mission: { maxCostUsd: 100 } })],
			missionStats: [{ missionId: "m1", agentId: "a1", lifetimeCostUsd: 85 }],
		});
		const report = await buildDailyReport(db, "u1", NOW);
		expect(report.flags.some((f) => f.label === "Spend")).toBe(true);
	});

	it("does not flag spend with no cap configured", async () => {
		const { db } = setup({
			missions: [missionDoc()],
			missionStats: [
				{ missionId: "m1", agentId: "a1", lifetimeCostUsd: 100_000 },
			],
		});
		const report = await buildDailyReport(db, "u1", NOW);
		expect(report.flags.some((f) => f.label === "Spend")).toBe(false);
	});

	it("flags upgrade-cap-near at or above 80% of the 24h cumulative cap", async () => {
		const { db } = setup({
			missions: [missionDoc()],
			machineSegments: [
				{
					missionId: "m1",
					shape: { cpuKind: "shared", cpus: 2, memoryMb: 4096 },
					upgraded: true,
					startedAt: new Date(NOW.getTime() - 20 * HOUR), // 20/24h = 83%
				},
			],
		});
		const report = await buildDailyReport(db, "u1", NOW);
		expect(report.flags.some((f) => f.label === "Upgrade cap")).toBe(true);
	});

	it("flags an idle upgraded machine with no running job", async () => {
		const { db } = setup({
			missions: [
				missionDoc({
					upgrade: {
						cpuKind: "shared",
						cpus: 2,
						memoryMb: 4096,
						expiresAt: NOW,
					},
				}),
			],
			machineSegments: [
				{
					missionId: "m1",
					shape: { cpuKind: "shared", cpus: 2, memoryMb: 4096 },
					upgraded: true,
					startedAt: new Date(NOW.getTime() - HOUR),
				},
			],
			missionStats: [
				{
					missionId: "m1",
					agentId: "a1",
					lastTurnAt: new Date(NOW.getTime() - 45 * 60_000),
				},
			],
			missionResources: [{ missionId: "m1", runningJobs: 0 }],
		});
		const report = await buildDailyReport(db, "u1", NOW);
		expect(report.flags.some((f) => f.label === "Upgraded machine idle")).toBe(
			true,
		);
	});

	it("flags a running mission with no resource sample yet as monitoring-blind", async () => {
		const { db } = setup({ missions: [missionDoc({ status: "running" })] });
		const report = await buildDailyReport(db, "u1", NOW);
		expect(report.flags.some((f) => f.label === "Monitoring blind")).toBe(true);
	});

	it("flags a running mission whose sample is stale (older than 5 min)", async () => {
		const { db } = setup({
			missions: [missionDoc({ status: "running" })],
			missionResources: [
				{
					missionId: "m1",
					diskUsedBytes: 1,
					diskTotalBytes: 10,
					updatedAt: new Date(NOW.getTime() - 30 * 60_000),
				},
			],
		});
		const report = await buildDailyReport(db, "u1", NOW);
		expect(report.flags.some((f) => f.label === "Monitoring blind")).toBe(true);
	});

	it("does not flag monitoring-blind for a suspended mission with no sample", async () => {
		const { db } = setup({ missions: [missionDoc({ status: "suspended" })] });
		const report = await buildDailyReport(db, "u1", NOW);
		expect(report.flags.some((f) => f.label === "Monitoring blind")).toBe(
			false,
		);
	});

	it("flags a chronic upgrade — upgraded on 5+ of the last 7 snapshots", async () => {
		const snapshots: Doc[] = [];
		for (let i = 1; i <= 5; i++) {
			snapshots.push({
				userId: "u1",
				date: `2026-09-${21 - i}`,
				generatedAt: new Date(NOW.getTime() - i * DAY),
				missions: { m1: { llmTotalUsd: 0, upgradedMs: HOUR } },
			});
		}
		const { db } = setup({
			missions: [missionDoc()],
			resourceSnapshots: snapshots,
		});
		const report = await buildDailyReport(db, "u1", NOW);
		expect(report.flags.some((f) => f.label === "Chronic upgrade")).toBe(true);
	});

	it("flags a rejected upgrade request from the last 24h (upgrade-cap-reached anomaly)", async () => {
		const { db } = setup({
			missions: [missionDoc()],
			missionAnomalies: [
				{
					missionId: "m1",
					category: "upgrade-cap-reached",
					severity: "hard",
					message: "24h cumulative cap reached",
					createdAt: new Date(NOW.getTime() - HOUR),
				},
			],
		});
		const report = await buildDailyReport(db, "u1", NOW);
		expect(report.flags.some((f) => f.label === "Upgrade rejected")).toBe(true);
	});

	it("does not flag a rejected upgrade older than 24h", async () => {
		const { db } = setup({
			missions: [missionDoc()],
			missionAnomalies: [
				{
					missionId: "m1",
					category: "upgrade-cap-reached",
					severity: "hard",
					message: "24h cumulative cap reached",
					createdAt: new Date(NOW.getTime() - 2 * DAY),
				},
			],
		});
		const report = await buildDailyReport(db, "u1", NOW);
		expect(report.flags.some((f) => f.label === "Upgrade rejected")).toBe(
			false,
		);
	});
});

describe("renderDailyReport", () => {
	it("renders an all-clear report with no FLAGS entries", () => {
		const text = renderDailyReport({
			userId: "u1",
			date: "2026-09-22",
			generatedAt: NOW,
			missions: [],
			flags: [],
		});
		expect(text).toContain("Daily resource report — 2026-09-22");
		expect(text).toContain("FLAGS: none — all clear");
		expect(text).toContain("MISSIONS");
	});

	it("renders the flag count and each flag line when flags are present", () => {
		const text = renderDailyReport({
			userId: "u1",
			date: "2026-09-22",
			generatedAt: NOW,
			missions: [],
			flags: [
				{ scope: "m1", label: "Disk", detail: "9 / 10 GB (90%)" },
				{
					scope: "platform",
					label: "Atlas storage",
					detail: "400 / 512 MB (78%)",
				},
			],
		});
		expect(text).toContain("FLAGS (2)");
		expect(text).toContain("Disk");
		expect(text).toContain("Atlas storage");
	});

	it("includes a PLATFORM section only when an Atlas block is present", () => {
		const withAtlas = renderDailyReport({
			userId: "u1",
			date: "2026-09-22",
			generatedAt: NOW,
			missions: [],
			flags: [],
			atlas: { usedBytes: 1, limitBytes: 2, databases: [], collections: [] },
		});
		expect(withAtlas).toContain("PLATFORM");

		const withoutAtlas = renderDailyReport({
			userId: "u1",
			date: "2026-09-22",
			generatedAt: NOW,
			missions: [],
			flags: [],
		});
		expect(withoutAtlas).not.toContain("PLATFORM");
	});

	it("lists each mission's row", () => {
		const text = renderDailyReport({
			userId: "u1",
			date: "2026-09-22",
			generatedAt: NOW,
			flags: [],
			missions: [
				{
					missionId: "gold-digest-v2",
					status: "running",
					llm24hUsd: 4.12,
					llmTotalUsd: 161.4,
					llmCapUsd: 250,
					shape: { cpuKind: "shared", cpus: 1, memoryMb: 1024 },
					upgraded: false,
					runningJobs: 0,
					upgradedMs24h: 0,
					upgradedMsSinceReset: 0,
					upgradedCapMs: 24 * HOUR,
					lastActivityAt: new Date(NOW.getTime() - 4 * 60_000),
				},
			],
		});
		expect(text).toContain("gold-digest-v2");
		expect(text).toContain("$4.12");
		expect(text).toContain("$161.40");
	});
});

describe("runDailyReportsIfDue", () => {
	it("does nothing before the report hour", async () => {
		const before = new Date("2026-09-22T11:00:00.000Z");
		const { db, data } = setup({ missions: [missionDoc()] });
		await runDailyReportsIfDue(db, {
			platformAdminUserIds: [],
			now: () => before,
		});
		expect(data.resourceSnapshots).toHaveLength(0);
		expect(data.mailbox).toHaveLength(0);
	});

	it("sends a report per user once at or after the report hour", async () => {
		const { db, data } = setup({
			missions: [
				missionDoc({ missionId: "m1", userId: "u1" }),
				missionDoc({ missionId: "m2", userId: "u2" }),
			],
		});
		await runDailyReportsIfDue(db, {
			platformAdminUserIds: [],
			now: () => NOW,
		});
		expect(data.resourceSnapshots).toHaveLength(2);
		expect(data.mailbox.map((m) => m.missionId).sort()).toEqual([
			"copilot-u1",
			"copilot-u2",
		]);
	});

	it("F-028 regression: each user's report only ever mentions their own missions", async () => {
		const { db, data } = setup({
			missions: [
				missionDoc({ missionId: "m1", userId: "u1" }),
				missionDoc({ missionId: "m2", userId: "u2" }),
			],
		});
		await runDailyReportsIfDue(db, {
			platformAdminUserIds: [],
			now: () => NOW,
		});
		const u1Mail = data.mailbox.find((m) => m.missionId === "copilot-u1");
		const u2Mail = data.mailbox.find((m) => m.missionId === "copilot-u2");
		expect(u1Mail?.body).toContain("m1");
		expect(u1Mail?.body).not.toContain("m2");
		expect(u2Mail?.body).toContain("m2");
		expect(u2Mail?.body).not.toContain("m1");
	});

	it("is idempotent on a second run the same day — never double-sends", async () => {
		const { db, data } = setup({ missions: [missionDoc()] });
		await runDailyReportsIfDue(db, {
			platformAdminUserIds: [],
			now: () => NOW,
		});
		await runDailyReportsIfDue(db, {
			platformAdminUserIds: [],
			now: () => new Date(NOW.getTime() + 5 * 60_000),
		});
		expect(data.resourceSnapshots).toHaveLength(1);
		expect(data.mailbox).toHaveLength(1);
	});

	it("catches up when the report hour was missed entirely (control plane was down)", async () => {
		const { db, data } = setup({ missions: [missionDoc()] });
		// Simulates a restart 3 hours after the report hour, with no earlier run today.
		const wellAfter = new Date("2026-09-22T15:00:00.000Z");
		await runDailyReportsIfDue(db, {
			platformAdminUserIds: [],
			now: () => wellAfter,
		});
		expect(data.resourceSnapshots).toHaveLength(1);
		expect(data.mailbox).toHaveLength(1);
	});

	it("respects a custom reportHourUtc", async () => {
		const { db, data } = setup({ missions: [missionDoc()] });
		await runDailyReportsIfDue(db, {
			platformAdminUserIds: [],
			reportHourUtc: 18,
			now: () => NOW, // noon — before the custom 18:00 hour
		});
		expect(data.resourceSnapshots).toHaveLength(0);
	});

	it("one user's failure never blocks another user's report", async () => {
		const { db, data } = setup({
			missions: [
				missionDoc({ missionId: "m1", userId: "u1" }),
				missionDoc({ missionId: "m2", userId: "u2" }),
			],
		});
		// Break the very first agentTurnStats read (u1's, processed first —
		// insertion order) so buildDailyReport throws for u1 only; u2's report
		// must still be built and sent normally afterwards.
		const realCollection = db.collection.bind(db);
		let agentTurnStatsCalls = 0;
		(db as unknown as { collection: typeof db.collection }).collection = ((
			name: string,
		) => {
			if (name === "agentTurnStats") {
				agentTurnStatsCalls++;
				if (agentTurnStatsCalls === 1) {
					return {
						aggregate() {
							throw new Error("boom");
						},
					} as never;
				}
			}
			return realCollection(name);
		}) as typeof db.collection;

		await expect(
			runDailyReportsIfDue(db, { platformAdminUserIds: [], now: () => NOW }),
		).resolves.toBeUndefined();
		expect(data.mailbox.some((m) => m.missionId === "copilot-u1")).toBe(false);
		expect(data.mailbox.some((m) => m.missionId === "copilot-u2")).toBe(true);
	});
});
