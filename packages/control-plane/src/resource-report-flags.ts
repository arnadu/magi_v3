/**
 * The daily report's flags: one pure check per category over a mission row
 * (disk, spend, upgrade cap, idle upgrade, blind monitoring) or the Atlas
 * block, then the two that read history (chronic upgrades, rejected
 * upgrades in the last day).
 */

import { COLLECTION_NAMES, storedCollection } from "@magi/agent-config";
import {
	ATLAS_STORAGE,
	DISK_USAGE,
	REPORT_FLAGS,
	UPGRADE_CAP_NEAR_RATIO,
	UPGRADE_IDLE_MINUTES,
	UPGRADE_LIMITS,
} from "@magi/agent-runtime-worker";
import type { Db } from "mongodb";
import { upgradeIdleRatio } from "./resource-alerts.js";
import {
	type AtlasReportBlock,
	DAY,
	formatShape,
	gb,
	type MissionReportRow,
	mb,
	type ReportFlag,
	type ResourceSnapshotDoc,
} from "./resource-report-types.js";

export function atlasFlag(atlas: AtlasReportBlock): ReportFlag | null {
	const ratio = atlas.usedBytes / atlas.limitBytes;
	if (ratio < ATLAS_STORAGE.soft) return null;
	const growth =
		atlas.growthBytesPerDay !== undefined
			? `, +${mb(atlas.growthBytesPerDay)} MB/24h`
			: "";
	const full =
		atlas.daysToFull !== undefined
			? `, full in ~${Math.round(atlas.daysToFull)} days`
			: "";
	return {
		scope: "platform",
		label: "Atlas storage",
		detail: `${mb(atlas.usedBytes)} / ${mb(atlas.limitBytes)} MB (${Math.round(ratio * 100)}%)${growth}${full}`,
	};
}

/** Disk nearly full, or growing fast enough to fill within the window (from yesterday's snapshot). */
export function diskFlag(
	m: MissionReportRow,
	yesterday: ResourceSnapshotDoc | null,
): ReportFlag | null {
	if (m.diskUsedBytes === undefined || !m.diskTotalBytes) return null;
	const ratio = m.diskUsedBytes / m.diskTotalBytes;
	const yesterdayUsed = yesterday?.missions[m.missionId]?.diskUsedBytes;
	const growthPerDay =
		yesterdayUsed !== undefined ? m.diskUsedBytes - yesterdayUsed : undefined;
	const daysToFull =
		growthPerDay !== undefined && growthPerDay > 0
			? (m.diskTotalBytes - m.diskUsedBytes) / growthPerDay
			: undefined;
	const soon =
		daysToFull !== undefined && daysToFull <= REPORT_FLAGS.diskFullWithinDays;
	if (ratio < DISK_USAGE.soft && !soon) return null;
	const growth =
		growthPerDay !== undefined ? `, growing ~${gb(growthPerDay)} GB/day` : "";
	const full =
		daysToFull !== undefined ? `, full in ~${Math.round(daysToFull)} days` : "";
	return {
		scope: m.missionId,
		label: "Disk",
		detail: `${gb(m.diskUsedBytes)} / ${gb(m.diskTotalBytes)} GB (${Math.round(ratio * 100)}%)${growth}${full}`,
	};
}

export function spendFlag(m: MissionReportRow): ReportFlag | null {
	if (!m.llmCapUsd) return null;
	const ratio = m.llmTotalUsd / m.llmCapUsd;
	if (ratio < REPORT_FLAGS.spendCapRatio) return null;
	return {
		scope: m.missionId,
		label: "Spend",
		detail: `$${m.llmTotalUsd.toFixed(2)} / $${m.llmCapUsd.toFixed(2)} (${Math.round(ratio * 100)}%)`,
	};
}

export function upgradeCapFlag(m: MissionReportRow): ReportFlag | null {
	if (m.upgradedMsSinceReset <= 0) return null;
	const ratio = m.upgradedMsSinceReset / m.upgradedCapMs;
	if (ratio < UPGRADE_CAP_NEAR_RATIO) return null;
	return {
		scope: m.missionId,
		label: "Upgrade cap",
		detail: `${Math.round(ratio * 100)}% of the ${UPGRADE_LIMITS.cumulativeCapHours}h cap since the last reset`,
	};
}

export function idleUpgradeFlag(
	m: MissionReportRow,
	now: Date,
): ReportFlag | null {
	if (!m.upgraded) return null;
	const ratio = upgradeIdleRatio({
		isUpgraded: true,
		runningJobs: m.runningJobs,
		lastActivityAt: m.lastActivityAt ?? null,
		now,
		idleMinutesThreshold: UPGRADE_IDLE_MINUTES,
	});
	if (ratio < 1) return null;
	const idleMin = Math.round(ratio * UPGRADE_IDLE_MINUTES);
	const expiresIn = m.activeUpgradeExpiresAt
		? Math.round((m.activeUpgradeExpiresAt.getTime() - now.getTime()) / 60_000)
		: undefined;
	return {
		scope: m.missionId,
		label: "Upgraded machine idle",
		detail: `idle ${idleMin} min (${formatShape(m.shape)}${expiresIn !== undefined ? `, expires in ${expiresIn} min` : ""})`,
	};
}

/** A running mission whose resource sample is missing or stale: the oversight tick cannot see it. */
export function blindFlag(m: MissionReportRow, now: Date): ReportFlag | null {
	if (m.status !== "running") return null;
	if (!m.diskSampleAt) {
		return {
			scope: m.missionId,
			label: "Monitoring blind",
			detail: "no resource sample yet",
		};
	}
	const ageMin = (now.getTime() - m.diskSampleAt.getTime()) / 60_000;
	if (ageMin <= REPORT_FLAGS.staleSampleMinutes) return null;
	return {
		scope: m.missionId,
		label: "Monitoring blind",
		detail: `resource sample is ${Math.round(ageMin)} min old`,
	};
}

/** Upgraded on enough of the recent snapshots that the default size is probably too small. */
export function chronicUpgradeFlags(
	missions: MissionReportRow[],
	recentSnapshots: ResourceSnapshotDoc[],
): ReportFlag[] {
	return missions.flatMap((m) => {
		const upgradedDays = recentSnapshots.filter(
			(s) => (s.missions[m.missionId]?.upgradedMs ?? 0) > 0,
		).length;
		return upgradedDays >= REPORT_FLAGS.chronicUpgradeDays
			? [
					{
						scope: m.missionId,
						label: "Chronic upgrade",
						detail: `upgraded on ${upgradedDays} of the last ${REPORT_FLAGS.chronicUpgradeWindowDays} snapshots — consider raising the mission's default machine size`,
					},
				]
			: [];
	});
}

export async function computeFlags(
	db: Db,
	userId: string,
	missions: MissionReportRow[],
	atlas: AtlasReportBlock | undefined,
	yesterday: ResourceSnapshotDoc | null,
	now: Date,
): Promise<ReportFlag[]> {
	const flags: ReportFlag[] = [];
	const atlasOne = atlas ? atlasFlag(atlas) : null;
	if (atlasOne) flags.push(atlasOne);
	for (const m of missions) {
		for (const f of [
			diskFlag(m, yesterday),
			spendFlag(m),
			upgradeCapFlag(m),
			idleUpgradeFlag(m, now),
			blindFlag(m, now),
		]) {
			if (f) flags.push(f);
		}
	}
	const recentSnapshots = await db
		.collection<ResourceSnapshotDoc>(COLLECTION_NAMES.resourceSnapshots)
		.find({ userId })
		.sort({ date: -1 })
		.limit(REPORT_FLAGS.chronicUpgradeWindowDays)
		.toArray();
	flags.push(...chronicUpgradeFlags(missions, recentSnapshots));
	if (missions.length > 0) {
		const rejected = await storedCollection(db, "missionAnomalies")
			.find({
				missionId: { $in: missions.map((m) => m.missionId) },
				category: "upgrade-cap-reached",
				createdAt: { $gte: new Date(now.getTime() - DAY) },
			})
			.toArray();
		for (const r of rejected) {
			flags.push({
				scope: r.missionId,
				label: "Upgrade rejected",
				detail: r.message,
			});
		}
	}
	return flags;
}
