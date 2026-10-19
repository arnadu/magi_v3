/**
 * The per-mission telemetry behind `GET /api/missions/stats` (the missions
 * list's unread badge, spend figures and "active … ago" line).
 *
 * Reads the collections that are actually written for this purpose
 * (issue #53): lifetime spend from `missionStats` (the same source the spend
 * cap reads), windowed spend from `agentTurnStats`, unread from the mailbox's
 * `readBy` array, last activity from `missionStats.lastTurnAt`. The previous
 * version aggregated `llmCallLog` on fields it never had (`cost`, `createdAt`)
 * and a collection that is pruned daily anyway, so every figure was zero.
 */

import {
	type AgentTurnStats,
	type MissionStats,
	storedCollection,
} from "@magi/agent-config";
import type { Db } from "mongodb";

export interface MissionStatsEntry {
	unread: number;
	spendTotal: number;
	spendToday: number;
	spendLastHour: number;
	lastActivity: Date | null;
	snippet: string | null;
}

interface MailDoc {
	missionId: string;
	from?: string;
	subject?: string;
}

/** UTC day boundary: the control plane runs in UTC and so do the agents' crons. */
export function utcDayStart(now: Date): Date {
	return new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
	);
}

export async function summarizeMissions(
	db: Db,
	missionIds: string[],
	now: Date = new Date(),
): Promise<Record<string, MissionStatsEntry>> {
	const stats: Record<string, MissionStatsEntry> = {};
	for (const id of missionIds) {
		stats[id] = {
			unread: 0,
			spendTotal: 0,
			spendToday: 0,
			spendLastHour: 0,
			lastActivity: null,
			snippet: null,
		};
	}
	if (missionIds.length === 0) return stats;

	const oneHourAgo = new Date(now.getTime() - 3_600_000);
	const todayStart = utcDayStart(now);
	const windowStart = todayStart < oneHourAgo ? todayStart : oneHourAgo;

	const [lifetime, turns, unreadMail, latestMail] = await Promise.all([
		storedCollection(db, "missionStats")
			.find(
				{ missionId: { $in: missionIds } },
				{ projection: { missionId: 1, lifetimeCostUsd: 1, lastTurnAt: 1 } },
			)
			.toArray(),
		storedCollection(db, "agentTurnStats")
			.find(
				{ missionId: { $in: missionIds }, startedAt: { $gte: windowStart } },
				{ projection: { missionId: 1, startedAt: 1, costUsd: 1 } },
			)
			.toArray(),
		// Unread for the operator = addressed to "user" and not yet read by "user".
		db
			.collection<MailDoc>("mailbox")
			.find(
				{ missionId: { $in: missionIds }, to: "user", readBy: { $ne: "user" } },
				{ projection: { missionId: 1 } },
			)
			.toArray(),
		db
			.collection<MailDoc>("mailbox")
			.find(
				{ missionId: { $in: missionIds }, to: "user" },
				{ projection: { missionId: 1, from: 1, subject: 1, timestamp: 1 } },
			)
			.sort({ timestamp: -1 })
			.limit(missionIds.length * 5)
			.toArray(),
	]);

	foldLifetime(stats, lifetime);
	foldTurns(stats, turns, todayStart, oneHourAgo);
	for (const m of unreadMail) {
		const s = stats[m.missionId];
		if (s) s.unread += 1;
	}
	foldSnippets(stats, latestMail);
	return stats;
}

function foldLifetime(
	stats: Record<string, MissionStatsEntry>,
	// Sparse documents are tolerated: rows written before a field existed.
	docs: (Pick<MissionStats, "missionId"> &
		Partial<Pick<MissionStats, "lifetimeCostUsd" | "lastTurnAt">>)[],
): void {
	for (const m of docs) {
		const s = stats[m.missionId];
		if (!s) continue;
		s.spendTotal += m.lifetimeCostUsd ?? 0;
		if (m.lastTurnAt && (!s.lastActivity || m.lastTurnAt > s.lastActivity)) {
			s.lastActivity = m.lastTurnAt;
		}
	}
}

function foldTurns(
	stats: Record<string, MissionStatsEntry>,
	docs: (Pick<AgentTurnStats, "missionId" | "startedAt"> &
		Partial<Pick<AgentTurnStats, "costUsd">>)[],
	todayStart: Date,
	oneHourAgo: Date,
): void {
	for (const t of docs) {
		const s = stats[t.missionId];
		if (!s) continue;
		const cost = t.costUsd ?? 0;
		if (t.startedAt >= todayStart) s.spendToday += cost;
		if (t.startedAt >= oneHourAgo) s.spendLastHour += cost;
	}
}

/** First (newest) message per mission wins; the query is sorted newest first. */
function foldSnippets(
	stats: Record<string, MissionStatsEntry>,
	docs: MailDoc[],
): void {
	for (const m of docs) {
		const s = stats[m.missionId];
		if (!s || s.snippet !== null) continue;
		const subject = (m.subject ?? "").trim();
		if (subject) s.snippet = `${m.from ?? "?"}: ${subject}`.slice(0, 120);
	}
}
