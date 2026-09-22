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

import { randomUUID } from "node:crypto";
import {
	ATLAS_STORAGE,
	createMongoAgentStatsRepository,
	DISK_USAGE,
	REPORT_FLAGS,
	UPGRADE_CAP_NEAR_RATIO,
	UPGRADE_IDLE_MINUTES,
	UPGRADE_LIMITS,
} from "@magi/agent-runtime-worker";
import type { Db } from "mongodb";
import {
	defaultShapeOf,
	getOpenSegment,
	upgradedMsSince,
} from "./machine-segments.js";
import type { MachineShape } from "./machine-shapes.js";
import { upgradeIdleRatio } from "./resource-alerts.js";
import {
	lastActivityAt,
	latestResourceSample,
	sumTurnCostUsd,
} from "./resource-queries.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const REPORT_HOUR_UTC_DEFAULT = 12;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MissionReportRow {
	missionId: string;
	status: string;
	llm24hUsd: number;
	llmTotalUsd: number;
	llmCapUsd?: number;
	shape: MachineShape;
	upgraded: boolean;
	runningJobs: number | null;
	upgradedMs24h: number;
	upgradedMsSinceReset: number;
	upgradedCapMs: number;
	activeUpgradeExpiresAt?: Date;
	diskUsedBytes?: number;
	diskTotalBytes?: number;
	diskSampleAt?: Date;
	lastActivityAt?: Date;
}

export interface AtlasReportBlock {
	usedBytes: number;
	limitBytes: number;
	databases: Array<{ name: string; bytes: number }>;
	collections: Array<{ name: string; bytes: number }>;
	growthBytesPerDay?: number;
	daysToFull?: number;
}

export interface ReportFlag {
	/** A missionId, or "platform" for a cross-mission/Atlas flag. */
	scope: string;
	label: string;
	detail: string;
}

export interface DailyReport {
	userId: string;
	date: string;
	generatedAt: Date;
	missions: MissionReportRow[];
	atlas?: AtlasReportBlock;
	flags: ReportFlag[];
}

interface MissionDocForReport {
	missionId: string;
	status: string;
	mission?: { maxCostUsd?: number; memoryMb?: number; cpus?: number };
	upgrade?: { expiresAt: Date };
	upgradedRuntimeResetAt?: Date;
}

interface SnapshotMissionEntry {
	diskUsedBytes?: number;
	llmTotalUsd: number;
	upgradedMs: number;
}

interface ResourceSnapshotDoc {
	userId: string;
	date: string;
	generatedAt: Date;
	missions: Record<string, SnapshotMissionEntry>;
	atlasBytes?: number;
}

const dateKey = (d: Date): string => d.toISOString().slice(0, 10);
const mb = (bytes: number): string => (bytes / 1024 ** 2).toFixed(1);
const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);
const hours = (ms: number): string => (ms / HOUR).toFixed(1);

function formatShape(s: MachineShape): string {
	const gib = s.memoryMb / 1024;
	return `${s.cpuKind} ${s.cpus} CPU / ${Number.isInteger(gib) ? gib : gib.toFixed(1)} GB`;
}

function minutesAgo(from: Date, to: Date): string {
	const min = Math.round((to.getTime() - from.getTime()) / 60_000);
	if (min < 60) return `${min} min ago`;
	if (min < 24 * 60) return `${(min / 60).toFixed(1)} h ago`;
	return `${Math.round(min / (24 * 60))} d ago`;
}

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
	const doc = await db
		.collection<{
			usedBytes: number;
			limitBytes: number;
			databases: Array<{ name: string; bytes: number }>;
			collections: Array<{ name: string; bytes: number }>;
		}>("platformResources")
		.findOne({ _id: "atlas" as unknown as never });
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

async function computeFlags(
	db: Db,
	userId: string,
	missions: MissionReportRow[],
	atlas: AtlasReportBlock | undefined,
	yesterday: ResourceSnapshotDoc | null,
	now: Date,
): Promise<ReportFlag[]> {
	const flags: ReportFlag[] = [];

	if (atlas) {
		const ratio = atlas.usedBytes / atlas.limitBytes;
		if (ratio >= ATLAS_STORAGE.soft) {
			const growth =
				atlas.growthBytesPerDay !== undefined
					? `, +${mb(atlas.growthBytesPerDay)} MB/24h`
					: "";
			const full =
				atlas.daysToFull !== undefined
					? `, full in ~${Math.round(atlas.daysToFull)} days`
					: "";
			flags.push({
				scope: "platform",
				label: "Atlas storage",
				detail: `${mb(atlas.usedBytes)} / ${mb(atlas.limitBytes)} MB (${Math.round(ratio * 100)}%)${growth}${full}`,
			});
		}
	}

	for (const m of missions) {
		if (m.diskUsedBytes !== undefined && m.diskTotalBytes) {
			const ratio = m.diskUsedBytes / m.diskTotalBytes;
			const yesterdayUsed = yesterday?.missions[m.missionId]?.diskUsedBytes;
			const growthPerDay =
				yesterdayUsed !== undefined
					? m.diskUsedBytes - yesterdayUsed
					: undefined;
			const daysToFull =
				growthPerDay !== undefined && growthPerDay > 0
					? (m.diskTotalBytes - m.diskUsedBytes) / growthPerDay
					: undefined;
			if (
				ratio >= DISK_USAGE.soft ||
				(daysToFull !== undefined &&
					daysToFull <= REPORT_FLAGS.diskFullWithinDays)
			) {
				const growth =
					growthPerDay !== undefined
						? `, growing ~${gb(growthPerDay)} GB/day`
						: "";
				const full =
					daysToFull !== undefined
						? `, full in ~${Math.round(daysToFull)} days`
						: "";
				flags.push({
					scope: m.missionId,
					label: "Disk",
					detail: `${gb(m.diskUsedBytes)} / ${gb(m.diskTotalBytes)} GB (${Math.round(ratio * 100)}%)${growth}${full}`,
				});
			}
		}

		if (m.llmCapUsd) {
			const ratio = m.llmTotalUsd / m.llmCapUsd;
			if (ratio >= REPORT_FLAGS.spendCapRatio) {
				flags.push({
					scope: m.missionId,
					label: "Spend",
					detail: `$${m.llmTotalUsd.toFixed(2)} / $${m.llmCapUsd.toFixed(2)} (${Math.round(ratio * 100)}%)`,
				});
			}
		}

		if (m.upgradedMsSinceReset > 0) {
			const ratio = m.upgradedMsSinceReset / m.upgradedCapMs;
			if (ratio >= UPGRADE_CAP_NEAR_RATIO) {
				flags.push({
					scope: m.missionId,
					label: "Upgrade cap",
					detail: `${Math.round(ratio * 100)}% of the ${UPGRADE_LIMITS.cumulativeCapHours}h cap since the last reset`,
				});
			}
		}

		if (m.upgraded) {
			const ratio = upgradeIdleRatio({
				isUpgraded: true,
				runningJobs: m.runningJobs,
				lastActivityAt: m.lastActivityAt ?? null,
				now,
				idleMinutesThreshold: UPGRADE_IDLE_MINUTES,
			});
			if (ratio >= 1) {
				const idleMin = Math.round(ratio * UPGRADE_IDLE_MINUTES);
				const expiresIn = m.activeUpgradeExpiresAt
					? Math.round(
							(m.activeUpgradeExpiresAt.getTime() - now.getTime()) / 60_000,
						)
					: undefined;
				flags.push({
					scope: m.missionId,
					label: "Upgraded machine idle",
					detail: `idle ${idleMin} min (${formatShape(m.shape)}${expiresIn !== undefined ? `, expires in ${expiresIn} min` : ""})`,
				});
			}
		}

		if (m.status === "running") {
			if (!m.diskSampleAt) {
				flags.push({
					scope: m.missionId,
					label: "Monitoring blind",
					detail: "no resource sample yet",
				});
			} else {
				const ageMin = (now.getTime() - m.diskSampleAt.getTime()) / 60_000;
				if (ageMin > REPORT_FLAGS.staleSampleMinutes) {
					flags.push({
						scope: m.missionId,
						label: "Monitoring blind",
						detail: `resource sample is ${Math.round(ageMin)} min old`,
					});
				}
			}
		}
	}

	const recentSnapshots = await db
		.collection<ResourceSnapshotDoc>("resourceSnapshots")
		.find({ userId })
		.sort({ date: -1 })
		.limit(REPORT_FLAGS.chronicUpgradeWindowDays)
		.toArray();
	for (const m of missions) {
		const upgradedDays = recentSnapshots.filter(
			(s) => (s.missions[m.missionId]?.upgradedMs ?? 0) > 0,
		).length;
		if (upgradedDays >= REPORT_FLAGS.chronicUpgradeDays) {
			flags.push({
				scope: m.missionId,
				label: "Chronic upgrade",
				detail: `upgraded on ${upgradedDays} of the last ${REPORT_FLAGS.chronicUpgradeWindowDays} snapshots — consider raising the mission's default machine size`,
			});
		}
	}

	if (missions.length > 0) {
		const rejected = await db
			.collection<{ missionId: string; message: string }>("missionAnomalies")
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

/** Builds one user's report. Never throws for a missing sample/cap/etc — every field is optional. */
export async function buildDailyReport(
	db: Db,
	userId: string,
	now: Date,
	opts: { isAdmin: boolean } = { isAdmin: false },
): Promise<DailyReport> {
	const date = dateKey(now);
	const missionDocs = await db
		.collection<MissionDocForReport>("missions")
		.find({ userId, status: { $nin: ["destroyed", "draft"] } })
		.toArray();
	const statsRepo = createMongoAgentStatsRepository(db);
	const missions = await Promise.all(
		missionDocs.map((m) => buildMissionRow(db, m, now, statsRepo)),
	);

	const yesterdayKey = dateKey(new Date(now.getTime() - DAY));
	const yesterday = await db
		.collection<ResourceSnapshotDoc>("resourceSnapshots")
		.findOne({ userId, date: yesterdayKey });

	const atlas = await readAtlasBlock(db, opts.isAdmin, yesterday);
	const flags = await computeFlags(db, userId, missions, atlas, yesterday, now);

	return { userId, date, generatedAt: now, missions, atlas, flags };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Renders a `DailyReport` as plain text for the copilot's mailbox. */
export function renderDailyReport(report: DailyReport): string {
	const lines: string[] = [];
	lines.push(`Daily resource report — ${report.date} (last 24 h)`);
	lines.push("");

	if (report.flags.length > 0) {
		lines.push(`FLAGS (${report.flags.length})`);
		for (const f of report.flags) {
			lines.push(`  ! ${f.label} [${f.scope}]  ${f.detail}`);
		}
	} else {
		lines.push("FLAGS: none — all clear");
	}
	lines.push("");

	if (report.atlas) {
		const pct = Math.round(
			(report.atlas.usedBytes / report.atlas.limitBytes) * 100,
		);
		const growth =
			report.atlas.growthBytesPerDay !== undefined
				? `, +${mb(report.atlas.growthBytesPerDay)} MB/24h`
				: "";
		lines.push("PLATFORM");
		lines.push(
			`  MongoDB Atlas   ${mb(report.atlas.usedBytes)} / ${mb(report.atlas.limitBytes)} MB (${pct}%)${growth}`,
		);
		const top = report.atlas.collections
			.slice(0, 5)
			.map((c) => `${c.name} ${mb(c.bytes)} MB`)
			.join(" · ");
		if (top) lines.push(`    top collections: ${top}`);
		lines.push("");
	}

	lines.push("MISSIONS");
	if (report.missions.length === 0) {
		lines.push("  (none)");
	}
	for (const m of report.missions) {
		const cap =
			m.llmCapUsd !== undefined ? ` / $${m.llmCapUsd.toFixed(2)}` : "";
		const disk =
			m.diskUsedBytes !== undefined && m.diskTotalBytes !== undefined
				? `${gb(m.diskUsedBytes)} / ${gb(m.diskTotalBytes)} GB`
				: "no sample";
		const activity = m.lastActivityAt
			? minutesAgo(m.lastActivityAt, report.generatedAt)
			: "never";
		lines.push(
			`  ${m.missionId} (${m.status})  LLM 24h $${m.llm24hUsd.toFixed(2)}  total $${m.llmTotalUsd.toFixed(2)}${cap}  machine ${formatShape(m.shape)}${m.upgraded ? " [upgraded]" : ""}  upgraded ${hours(m.upgradedMsSinceReset)}h / ${hours(m.upgradedCapMs)}h cap  disk ${disk}  last activity ${activity}`,
		);
	}

	const totalUpgradedMs24h = report.missions.reduce(
		(sum, m) => sum + m.upgradedMs24h,
		0,
	);
	const active = report.missions.filter((m) => m.upgraded);
	if (totalUpgradedMs24h > 0 || active.length > 0) {
		lines.push("");
		lines.push("UPGRADES (ADR-0031 dataset)");
		lines.push(
			`  Total upgraded time in the last 24h: ${hours(totalUpgradedMs24h)}h`,
		);
		for (const m of active) {
			const expiresIn = m.activeUpgradeExpiresAt
				? Math.round(
						(m.activeUpgradeExpiresAt.getTime() -
							report.generatedAt.getTime()) /
							60_000,
					)
				: undefined;
			lines.push(
				`  Active now: ${m.missionId} (${formatShape(m.shape)})${expiresIn !== undefined ? `, expires in ${expiresIn} min` : ""}`,
			);
		}
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Persistence and scheduling
// ---------------------------------------------------------------------------

const indexed = new WeakSet<Db>();

function snapshotCollection(db: Db) {
	const col = db.collection<ResourceSnapshotDoc & { _id?: unknown }>(
		"resourceSnapshots",
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
	await db.collection("mailbox").insertOne({
		id: randomUUID(),
		missionId: `copilot-${report.userId}`,
		from: "system",
		to: ["copilot"],
		subject: `Daily resource report — ${report.date}`,
		body: renderDailyReport(report),
		timestamp: new Date(),
		readBy: [],
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

	const userIds: string[] = await db
		.collection("missions")
		.distinct("userId", { status: { $nin: ["destroyed", "draft"] } });

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
