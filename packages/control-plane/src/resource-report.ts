/**
 * The daily resource report (ADR-0032 Decision 5): one report per user who
 * owns a non-destroyed, non-draft mission, built and sent once per day at
 * `RESOURCE_REPORT_HOUR_UTC` (default 12 UTC), posted to `copilot-{userId}`.
 *
 * Idempotency and catch-up: `resourceSnapshots` is keyed `(userId, date)` with
 * an atomic `$setOnInsert` upsert as the send claim — only the call that
 * actually creates the day's snapshot document sends the mailbox message, so
 * a race or a retry never double-sends. `runDailyReportsIfDue` fires once
 * `now` is at or past today's report-hour boundary, not only in the exact
 * hour, so a control plane that was down through the whole report hour still
 * sends as soon as it's back up, any time later that same day.
 *
 * Persist-before-post is a deliberate choice: if posting the mailbox message
 * fails after the snapshot is claimed, the report is not retried that day
 * (logged, not silently lost) — the alternative (post-before-persist) risks a
 * duplicate send on a crash between the two steps, which is worse for a
 * report than a rare missed delivery already visible in the logs.
 *
 * Scoped down from the ADR's illustrative sample report: the sample's "N
 * requests, M renewals" upgrade counts aren't derivable from the current
 * `machineSegments` schema (a same-shape renewal extends a segment's
 * `plannedEndAt` rather than opening a new one, so there is no stored
 * "renewal count"). This report shows total upgraded time and any
 * currently-active upgrade instead — accurate to what's actually tracked,
 * rather than inventing a new counter mid-implementation. All wording here is
 * a first draft for review, not fixed by any test — see CLAUDE.md's Testing
 * Approach: prompt/report wording is judged manually, not asserted on.
 */

import {
	type AtlasUsageDoc,
	COLLECTION_NAMES,
	platformResourceCollection,
	storedCollection,
} from "@magi/agent-config";
import {
	createMongoAgentStatsRepository,
	UPGRADE_LIMITS,
} from "@magi/agent-runtime-worker";
import type { Db } from "mongodb";
import {
	defaultShapeOf,
	getOpenSegment,
	upgradedMsSince,
} from "./machine-segments.js";
import { postMailbox } from "./mailbox-writer.js";
import {
	lastActivityAt,
	latestResourceSample,
	sumTurnCostUsd,
} from "./resource-queries.js";
import { computeFlags } from "./resource-report-flags.js";
import { renderDailyReport } from "./resource-report-render.js";
import {
	type AtlasReportBlock,
	DAY,
	type DailyReport,
	dateKey,
	HOUR,
	type MissionDocForReport,
	type MissionReportRow,
	type ResourceSnapshotDoc,
	type SnapshotMissionEntry,
} from "./resource-report-types.js";

export type {
	AtlasReportBlock,
	DailyReport,
	MissionReportRow,
	ReportFlag,
} from "./resource-report-types.js";
export { renderDailyReport };

const REPORT_HOUR_UTC_DEFAULT = 12;

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

async function buildMissionRow(
	db: Db,
	mission: MissionDocForReport,
	now: Date,
	statsRepo: ReturnType<typeof createMongoAgentStatsRepository>,
): Promise<MissionReportRow> {
	const since = mission.upgradedRuntimeResetAt ?? new Date(0);
	const [
		snapshot,
		llm24hUsd,
		openSegment,
		sample,
		activity,
		upgradedMsSinceReset,
		upgradedMs24h,
	] = await Promise.all([
		statsRepo.readMissionSnapshot(mission.missionId),
		sumTurnCostUsd(db, mission.missionId, new Date(now.getTime() - DAY), now),
		getOpenSegment(db, mission.missionId),
		latestResourceSample(db, mission.missionId),
		lastActivityAt(db, mission.missionId),
		upgradedMsSince(db, mission.missionId, since, now, "elapsed"),
		upgradedMsSince(
			db,
			mission.missionId,
			new Date(now.getTime() - DAY),
			now,
			"elapsed",
		),
	]);
	const llmTotalUsd = snapshot.reduce(
		(sum, a) => sum + a.lifetimeCostUsd + a.turnCostUsd,
		0,
	);

	return {
		missionId: mission.missionId,
		status: mission.status,
		llm24hUsd,
		llmTotalUsd,
		llmCapUsd: mission.mission?.maxCostUsd,
		shape: openSegment?.shape ?? defaultShapeOf(mission),
		upgraded: openSegment?.upgraded ?? false,
		runningJobs: sample?.runningJobs ?? null,
		upgradedMs24h,
		upgradedMsSinceReset,
		upgradedCapMs: UPGRADE_LIMITS.cumulativeCapHours * HOUR,
		activeUpgradeExpiresAt: mission.upgrade?.expiresAt,
		diskUsedBytes: sample?.diskUsedBytes,
		diskTotalBytes: sample?.diskTotalBytes,
		diskSampleAt: sample?.updatedAt,
		lastActivityAt: activity ?? undefined,
	};
}

async function readAtlasBlock(
	db: Db,
	isAdmin: boolean,
	yesterday: ResourceSnapshotDoc | null,
): Promise<AtlasReportBlock | undefined> {
	if (!isAdmin) return undefined;
	const doc = await platformResourceCollection<AtlasUsageDoc>(db).findOne({
		_id: "atlas",
	});
	if (!doc) return undefined;

	const block: AtlasReportBlock = {
		usedBytes: doc.usedBytes,
		limitBytes: doc.limitBytes,
		databases: doc.databases,
		collections: doc.collections,
	};
	if (yesterday?.atlasBytes !== undefined) {
		block.growthBytesPerDay = doc.usedBytes - yesterday.atlasBytes;
		if (block.growthBytesPerDay > 0) {
			block.daysToFull =
				(doc.limitBytes - doc.usedBytes) / block.growthBytesPerDay;
		}
	}
	return block;
}

/** Builds one user's report. Never throws for a missing sample/cap/etc — every field is optional. */
export async function buildDailyReport(
	db: Db,
	userId: string,
	now: Date,
	opts: { isAdmin: boolean } = { isAdmin: false },
): Promise<DailyReport> {
	const date = dateKey(now);
	const missionDocs = await storedCollection(db, "missions")
		.find({ userId, status: { $nin: ["destroyed", "draft"] } })
		.toArray();
	const statsRepo = createMongoAgentStatsRepository(db);
	const missions = await Promise.all(
		missionDocs.map((m) => buildMissionRow(db, m, now, statsRepo)),
	);

	const yesterdayKey = dateKey(new Date(now.getTime() - DAY));
	const yesterday = await db
		.collection<ResourceSnapshotDoc>(COLLECTION_NAMES.resourceSnapshots)
		.findOne({ userId, date: yesterdayKey });

	const atlas = await readAtlasBlock(db, opts.isAdmin, yesterday);
	const flags = await computeFlags(db, userId, missions, atlas, yesterday, now);

	return { userId, date, generatedAt: now, missions, atlas, flags };
}

// ---------------------------------------------------------------------------
// Persistence and scheduling
// ---------------------------------------------------------------------------

const indexed = new WeakSet<Db>();

function snapshotCollection(db: Db) {
	const col = db.collection<ResourceSnapshotDoc & { _id?: unknown }>(
		COLLECTION_NAMES.resourceSnapshots,
	);
	if (!indexed.has(db)) {
		indexed.add(db);
		col
			.createIndex({ userId: 1, date: 1 }, { unique: true })
			.catch((e: unknown) =>
				console.warn(
					"[resource-report] Failed to create resourceSnapshots index:",
					(e as Error).message,
				),
			);
	}
	return col;
}

/**
 * Atomically claims today's send for this user via `$setOnInsert` — only the
 * call that actually inserts the snapshot document returns true. A second,
 * racing call (or the same day's later tick) sees the doc already exists and
 * returns false without touching it.
 */
async function claimAndPersistSnapshot(
	db: Db,
	report: DailyReport,
): Promise<boolean> {
	const missions: Record<string, SnapshotMissionEntry> = {};
	for (const m of report.missions) {
		missions[m.missionId] = {
			diskUsedBytes: m.diskUsedBytes,
			llmTotalUsd: m.llmTotalUsd,
			upgradedMs: m.upgradedMsSinceReset,
		};
	}
	const result = await snapshotCollection(db).updateOne(
		{ userId: report.userId, date: report.date },
		{
			$setOnInsert: {
				userId: report.userId,
				date: report.date,
				generatedAt: report.generatedAt,
				missions,
				...(report.atlas !== undefined && {
					atlasBytes: report.atlas.usedBytes,
				}),
			},
		},
		{ upsert: true },
	);
	return result.upsertedCount === 1;
}

async function postReportMail(db: Db, report: DailyReport): Promise<void> {
	await postMailbox(db, {
		missionId: `copilot-${report.userId}`,
		from: "system",
		to: ["copilot"],
		subject: `Daily resource report — ${report.date}`,
		body: renderDailyReport(report),
	});
}

async function sendDailyReportIfNeeded(
	db: Db,
	userId: string,
	now: Date,
	isAdmin: boolean,
): Promise<void> {
	const date = dateKey(now);
	const already = await snapshotCollection(db).findOne(
		{ userId, date },
		{ projection: { _id: 1 } },
	);
	if (already) return;

	const report = await buildDailyReport(db, userId, now, { isAdmin });
	const claimed = await claimAndPersistSnapshot(db, report);
	if (!claimed) return;

	await postReportMail(db, report).catch((e) =>
		console.error(
			`[resource-report] Failed to post report mailbox message { userId: "${userId}", error: "${(e as Error).message}" }`,
		),
	);
}

export interface DailyReportDeps {
	platformAdminUserIds: string[];
	/** Defaults to `RESOURCE_REPORT_HOUR_UTC` env, else 12. */
	reportHourUtc?: number;
	now?: () => Date;
}

/**
 * Builds and sends every user's daily report once `now` is at or past
 * today's report-hour boundary — not only inside the exact hour, so a control
 * plane that was down through the whole report hour still catches up later
 * the same day. Per-user failures are caught so one user's report never
 * blocks another's.
 */
export async function runDailyReportsIfDue(
	db: Db,
	deps: DailyReportDeps,
): Promise<void> {
	const now = (deps.now ?? (() => new Date()))();
	const reportHour = deps.reportHourUtc ?? REPORT_HOUR_UTC_DEFAULT;
	const reportTimeToday = new Date(
		Date.UTC(
			now.getUTCFullYear(),
			now.getUTCMonth(),
			now.getUTCDate(),
			reportHour,
		),
	);
	if (now < reportTimeToday) return;

	const userIds: string[] = await storedCollection(db, "missions").distinct(
		"userId",
		{ status: { $nin: ["destroyed", "draft"] } },
	);

	for (const userId of userIds) {
		await sendDailyReportIfNeeded(
			db,
			userId,
			now,
			deps.platformAdminUserIds.includes(userId),
		).catch((e) =>
			console.error(
				`[resource-report] Failed to build/send report { userId: "${userId}", error: "${(e as Error).message}" }`,
			),
		);
	}
}
