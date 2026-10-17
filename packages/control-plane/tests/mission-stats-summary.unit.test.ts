/**
 * GET /api/missions/stats reads the collections the daemon actually writes
 * (issue #53): lifetime spend from missionStats, windowed spend from
 * agentTurnStats, unread from the mailbox's readBy, snippet from the last
 * message to the operator.
 */

import { describe, expect, it } from "vitest";
import {
	summarizeMissions,
	utcDayStart,
} from "../src/mission-stats-summary.js";
import { fakeDb } from "./support/fake-db.js";

const NOW = new Date("2026-10-17T15:30:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

describe("summarizeMissions", () => {
	it("computes spend, unread and snippet per mission from the real writers' collections", async () => {
		const { db } = fakeDb({
			missionStats: [
				{
					missionId: "m1",
					agentId: "a1",
					lifetimeCostUsd: 4.5,
					lastTurnAt: ago(50),
				},
				{
					missionId: "m1",
					agentId: "a2",
					lifetimeCostUsd: 1.5,
					lastTurnAt: ago(10),
				},
				{
					missionId: "other",
					agentId: "x",
					lifetimeCostUsd: 99,
					lastTurnAt: NOW,
				},
			],
			agentTurnStats: [
				{ missionId: "m1", agentId: "a1", startedAt: ago(10), costUsd: 0.5 }, // last hour + today
				{
					missionId: "m1",
					agentId: "a2",
					startedAt: ago(5 * 60),
					costUsd: 0.25,
				}, // today only
				{ missionId: "m1", agentId: "a2", startedAt: ago(30 * 60), costUsd: 3 }, // yesterday
			],
			mailbox: [
				{
					missionId: "m1",
					from: "a1",
					to: ["user"],
					subject: "Brief ready",
					readBy: [],
					timestamp: ago(10),
				},
				{
					missionId: "m1",
					from: "a2",
					to: ["user", "a1"],
					subject: "Old",
					readBy: ["user", "a1"],
					timestamp: ago(100),
				},
				{
					missionId: "m1",
					from: "a1",
					to: ["a2"],
					subject: "internal",
					readBy: [],
					timestamp: ago(1),
				},
			],
		});

		const stats = await summarizeMissions(db as never, ["m1", "m2"], NOW);

		expect(stats.m1).toEqual({
			unread: 1,
			spendTotal: 6,
			spendToday: 0.75,
			spendLastHour: 0.5,
			lastActivity: ago(10),
			snippet: "a1: Brief ready",
		});
		expect(stats.m2).toEqual({
			unread: 0,
			spendTotal: 0,
			spendToday: 0,
			spendLastHour: 0,
			lastActivity: null,
			snippet: null,
		});
		expect(stats.other).toBeUndefined();
	});

	it("uses the UTC day boundary", () => {
		expect(
			utcDayStart(new Date("2026-10-17T00:30:00-04:00")).toISOString(),
		).toBe("2026-10-17T00:00:00.000Z");
	});

	it("returns an empty object for no missions without querying", async () => {
		const { db } = fakeDb({});
		expect(await summarizeMissions(db as never, [], NOW)).toEqual({});
	});
});
