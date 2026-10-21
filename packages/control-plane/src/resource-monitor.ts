/**
 * The 5-minute resource-oversight tick (ADR-0032): the cross-cutting Atlas
 * storage and OOM-detection checks, four per-mission alert categories —
 * `spend-cap-near` (missionStats totals vs the mission's own cap),
 * `spend-spike` (agentTurnStats, 24h spend vs a trailing 7-day daily
 * average — the `{missionId, startedAt}` index added in step 1.4 exists
 * specifically for this windowed query), `upgrade-cap-near` (machine
 * segments vs the cumulative upgrade cap), and `upgrade-idle` (an upgraded
 * machine with no conversation activity and no running job) — plus, once
 * `now` reaches `RESOURCE_REPORT_HOUR_UTC` for the day, the daily report
 * (`resource-report.ts`).
 *
 * Every per-mission and cross-cutting check is independently caught — one
 * mission's failure, or the Atlas/OOM/report checks failing, must never stop
 * the rest of the tick. Started once from index.ts alongside the scheduler
 * and copilot waker.
 */

import { type MissionDoc, storedCollection } from "@magi/agent-config";
import {
	type AlertStateStore,
	createMongoAgentStatsRepository,
	createMongoAlertStateStore,
	createMongoAnomalyRecorderForMission,
	evaluateAlert,
	SPEND_CAP,
	SPEND_SPIKE,
	SPEND_SPIKE_RATIO,
	UNCAPPED_SPEND,
	UNCAPPED_SPEND_UNIT_USD,
	UPGRADE_CAP_NEAR,
	UPGRADE_IDLE,
	UPGRADE_IDLE_MINUTES,
	UPGRADE_LIMITS,
} from "@magi/agent-runtime-worker";
import type { Db, MongoClient } from "mongodb";
import { schedule } from "node-cron";
import { checkAtlasStorage } from "./atlas-usage.js";
import { checkOomExits } from "./fly-events.js";
import { checkOrphanMachines } from "./fly-orphans.js";
import { upgradedMsSince } from "./machine-segments.js";
import {
	spendCapRatio,
	spendSpikeRatio,
	upgradeCapNearRatio,
	upgradeIdleRatio,
} from "./resource-alerts.js";
import {
	lastActivityAt,
	latestResourceSample,
	sumTurnCostUsd,
} from "./resource-queries.js";
import { runDailyReportsIfDue } from "./resource-report.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type MissionRow = Pick<
	MissionDoc,
	| "missionId"
	| "userId"
	| "mission"
	| "upgrade"
	| "upgradedRuntimeResetAt"
	| "createdAt"
>;

async function runningMissions(db: Db): Promise<MissionRow[]> {
	return storedCollection(db, "missions")
		.find(
			{ status: "running" },
			{
				projection: {
					missionId: 1,
					userId: 1,
					mission: 1,
					upgrade: 1,
					upgradedRuntimeResetAt: 1,
					createdAt: 1,
				},
			},
		)
		.toArray();
}

async function checkSpendCapNear(
	db: Db,
	mission: MissionRow,
	alertStore: AlertStateStore,
	now: Date,
): Promise<void> {
	const snapshot = await createMongoAgentStatsRepository(
		db,
	).readMissionSnapshot(mission.missionId);
	const totalSpendUsd = snapshot.reduce(
		(sum, a) => sum + a.lifetimeCostUsd + a.turnCostUsd,
		0,
	);
	const ratio = spendCapRatio(totalSpendUsd, mission.mission?.maxCostUsd);
	if (ratio === null) {
		// No cap at all (cleared after creation — every new mission gets one):
		// the one state the cap-near alert can never report on.
		await checkUncappedSpend(db, mission, alertStore, now, totalSpendUsd);
		return;
	}

	const level = await evaluateAlert(
		alertStore,
		`${mission.missionId}:spend-cap-near`,
		ratio,
		SPEND_CAP,
		now,
	);
	if (!level) return;

	const capUsd = mission.mission?.maxCostUsd as number;
	await createMongoAnomalyRecorderForMission(
		db,
		mission.missionId,
		mission.userId,
	).record({
		missionId: mission.missionId,
		category: "spend-cap-near",
		severity: level,
		message: `Mission spend is at ${Math.round(ratio * 100)}% of its $${capUsd.toFixed(2)} cap ($${totalSpendUsd.toFixed(2)} spent).`,
	});
}

async function checkUncappedSpend(
	db: Db,
	mission: MissionRow,
	alertStore: AlertStateStore,
	now: Date,
	totalSpendUsd: number,
): Promise<void> {
	const level = await evaluateAlert(
		alertStore,
		`${mission.missionId}:uncapped-spend`,
		totalSpendUsd / UNCAPPED_SPEND_UNIT_USD,
		UNCAPPED_SPEND,
		now,
	);
	if (!level) return;
	await createMongoAnomalyRecorderForMission(
		db,
		mission.missionId,
		mission.userId,
	).record({
		missionId: mission.missionId,
		category: "uncapped-spend",
		severity: level,
		message: `Mission has no spend cap and has spent $${totalSpendUsd.toFixed(2)} so far. Set one in the Limits panel (or SetMissionSpendCap) — the platform ceiling applies, but it is not a cap.`,
	});
}

async function checkSpendSpike(
	db: Db,
	mission: MissionRow,
	alertStore: AlertStateStore,
	now: Date,
): Promise<void> {
	const windowMs = SPEND_SPIKE.windowHours * HOUR;
	const last24h = await sumTurnCostUsd(
		db,
		mission.missionId,
		new Date(now.getTime() - windowMs),
		now,
	);
	const baselineTo = new Date(now.getTime() - windowMs);
	const baselineFrom = new Date(
		baselineTo.getTime() - SPEND_SPIKE.baselineDays * DAY,
	);
	// RM1: average over the days the mission existed in the baseline window,
	// not always 7 — a 2-day-old mission's average was understated 3.5×, and
	// every busy day looked like a spike. Under a day of history: no baseline.
	const baselineDays =
		(baselineTo.getTime() -
			Math.max(baselineFrom.getTime(), mission.createdAt.getTime())) /
		DAY;
	if (baselineDays < 1) return;
	const baselineTotal = await sumTurnCostUsd(
		db,
		mission.missionId,
		new Date(baselineTo.getTime() - baselineDays * DAY),
		baselineTo,
	);
	const trailingDailyAvg = baselineTotal / baselineDays;
	const ratio = spendSpikeRatio(last24h, trailingDailyAvg);
	if (ratio <= 0) return;

	const level = await evaluateAlert(
		alertStore,
		`${mission.missionId}:spend-spike`,
		ratio,
		SPEND_SPIKE_RATIO,
		now,
	);
	if (!level) return;

	await createMongoAnomalyRecorderForMission(
		db,
		mission.missionId,
		mission.userId,
	).record({
		missionId: mission.missionId,
		category: "spend-spike",
		severity: level,
		message: `24h spend is $${last24h.toFixed(2)}, ${(last24h / Math.max(trailingDailyAvg, 0.01)).toFixed(1)}x the trailing ${baselineDays >= SPEND_SPIKE.baselineDays ? "7-day" : `${baselineDays.toFixed(1)}-day`} daily average ($${trailingDailyAvg.toFixed(2)}/day).`,
	});
}

async function checkUpgradeCapNear(
	db: Db,
	mission: MissionRow,
	alertStore: AlertStateStore,
	now: Date,
): Promise<void> {
	const capMs = UPGRADE_LIMITS.cumulativeCapHours * HOUR;
	const since = mission.upgradedRuntimeResetAt ?? new Date(0);
	const upgradedMs = await upgradedMsSince(
		db,
		mission.missionId,
		since,
		now,
		"elapsed",
	);
	const ratio = upgradeCapNearRatio(upgradedMs, capMs);
	if (ratio <= 0) return;

	const level = await evaluateAlert(
		alertStore,
		`${mission.missionId}:upgrade-cap-near`,
		ratio,
		UPGRADE_CAP_NEAR,
		now,
	);
	if (!level) return;

	await createMongoAnomalyRecorderForMission(
		db,
		mission.missionId,
		mission.userId,
	).record({
		missionId: mission.missionId,
		category: "upgrade-cap-near",
		severity: level,
		message: `Cumulative upgraded machine time is at ${Math.round(ratio * 100)}% of the ${UPGRADE_LIMITS.cumulativeCapHours}h cap since the last operator reset.`,
	});
}

async function checkUpgradeIdle(
	db: Db,
	mission: MissionRow,
	alertStore: AlertStateStore,
	now: Date,
): Promise<void> {
	if (!mission.upgrade) return;

	const [sample, activity] = await Promise.all([
		latestResourceSample(db, mission.missionId),
		lastActivityAt(db, mission.missionId),
	]);
	const ratio = upgradeIdleRatio({
		isUpgraded: true,
		runningJobs: sample?.runningJobs ?? null,
		lastActivityAt: activity,
		now,
		idleMinutesThreshold: UPGRADE_IDLE_MINUTES,
	});
	if (ratio <= 0) return;

	const level = await evaluateAlert(
		alertStore,
		`${mission.missionId}:upgrade-idle`,
		ratio,
		UPGRADE_IDLE,
		now,
	);
	if (!level) return;

	await createMongoAnomalyRecorderForMission(
		db,
		mission.missionId,
		mission.userId,
	).record({
		missionId: mission.missionId,
		category: "upgrade-idle",
		severity: level,
		message: `The mission's upgraded machine has had no conversation activity and no running background job for ${Math.round(ratio * UPGRADE_IDLE_MINUTES)} min. Consider ending the upgrade if the work is done.`,
	});
}

/** Every per-mission check (spend-cap-near, spend-spike, upgrade-cap-near, upgrade-idle). Exported for testing. */
export async function checkMission(
	db: Db,
	mission: MissionRow,
	alertStore: AlertStateStore,
	now: Date,
): Promise<void> {
	await checkSpendCapNear(db, mission, alertStore, now).catch((e) =>
		console.error(
			`[resource-monitor] spend-cap-near failed { missionId: "${mission.missionId}", error: "${(e as Error).message}" }`,
		),
	);
	await checkSpendSpike(db, mission, alertStore, now).catch((e) =>
		console.error(
			`[resource-monitor] spend-spike failed { missionId: "${mission.missionId}", error: "${(e as Error).message}" }`,
		),
	);
	await checkUpgradeCapNear(db, mission, alertStore, now).catch((e) =>
		console.error(
			`[resource-monitor] upgrade-cap-near failed { missionId: "${mission.missionId}", error: "${(e as Error).message}" }`,
		),
	);
	await checkUpgradeIdle(db, mission, alertStore, now).catch((e) =>
		console.error(
			`[resource-monitor] upgrade-idle failed { missionId: "${mission.missionId}", error: "${(e as Error).message}" }`,
		),
	);
}

export interface ResourceMonitorDeps {
	platformAdminUserIds: string[];
	/** Defaults to `ATLAS_STORAGE_LIMIT_MB` env, else the tier default — see `atlas-usage.ts`. */
	atlasStorageLimitMb?: number;
	/** Defaults to `RESOURCE_REPORT_HOUR_UTC` env, else 12 — see `resource-report.ts`. */
	reportHourUtc?: number;
	now?: () => Date;
}

export async function runResourceMonitorTick(
	db: Db,
	client: MongoClient,
	deps: ResourceMonitorDeps,
): Promise<void> {
	const now = (deps.now ?? (() => new Date()))();
	const alertStore = createMongoAlertStateStore(db);

	await checkAtlasStorage({
		client,
		db,
		limitMb: deps.atlasStorageLimitMb,
		platformAdminUserIds: deps.platformAdminUserIds,
	}).catch((e) =>
		console.error(
			`[resource-monitor] Atlas check failed: ${(e as Error).message}`,
		),
	);

	await checkOomExits(db).catch((e) =>
		console.error(
			`[resource-monitor] OOM check failed: ${(e as Error).message}`,
		),
	);

	await checkOrphanMachines({
		db,
		platformAdminUserIds: deps.platformAdminUserIds,
		now: () => now,
	}).catch((e) =>
		console.error(
			`[resource-monitor] Orphan-machine check failed: ${(e as Error).message}`,
		),
	);

	const missions = await runningMissions(db).catch((e) => {
		console.error(
			`[resource-monitor] Failed to list running missions: ${(e as Error).message}`,
		);
		return [] as MissionRow[];
	});

	for (const mission of missions) {
		await checkMission(db, mission, alertStore, now);
	}

	await runDailyReportsIfDue(db, {
		platformAdminUserIds: deps.platformAdminUserIds,
		reportHourUtc: deps.reportHourUtc,
		now: () => now,
	}).catch((e) =>
		console.error(
			`[resource-monitor] Daily report check failed: ${(e as Error).message}`,
		),
	);
}

/** Start the 5-min resource-monitor tick. Also runs once immediately. Returns a stop function. */
export function startResourceMonitor(
	db: Db,
	client: MongoClient,
	deps: ResourceMonitorDeps,
): () => void {
	// RM3: a tick slower than 5 minutes (Fly or Atlas timeouts) must not
	// overlap the next — two would evaluate and claim the same alerts and
	// daily reports concurrently. An overlapping tick is skipped, not queued.
	let running = false;
	const tick = async () => {
		if (running) {
			console.warn(
				"[resource-monitor] Previous tick still running — skipping this one",
			);
			return;
		}
		running = true;
		try {
			await runResourceMonitorTick(db, client, deps);
		} catch (e) {
			console.error(`[resource-monitor] Tick failed: ${(e as Error).message}`);
		} finally {
			running = false;
		}
	};

	void tick();
	const task = schedule("*/5 * * * *", tick);
	return () => task.stop();
}
