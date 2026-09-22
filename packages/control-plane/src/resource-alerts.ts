/**
 * Pure per-mission resource-alert ratio calculators (ADR-0032 Decision 2/4).
 *
 * No I/O — `resource-monitor.ts` fetches the inputs (missionStats totals,
 * agentTurnStats windows, machine-segments runtime, the disk sampler's
 * `runningJobs` reading) and calls `evaluateAlert` with the ratio each
 * function returns here, against the matching threshold in
 * `resource-thresholds.ts`. Kept separate from the orchestration so the
 * alerting *logic* is unit-testable without a database.
 */

import { SPEND_SPIKE } from "@magi/agent-runtime-worker";

/** Fraction of the mission's spend cap used so far; null when no cap is configured. */
export function spendCapRatio(
	totalSpendUsd: number,
	capUsd: number | undefined,
): number | null {
	if (capUsd === undefined || capUsd <= 0) return null;
	return totalSpendUsd / capUsd;
}

/**
 * `last24hSpendUsd / (SPEND_SPIKE.multiplier * trailingDailyAvgUsd)` — 1.0 is
 * exactly at the multiplier, so `evaluateAlert` against `SPEND_SPIKE_RATIO`
 * (soft at 1.0) fires exactly at ADR-0032's "3x trailing average" line. 0
 * (never fires) when spend is below `minUsd` — too small to call a spike —
 * or there is no baseline yet (a mission in its first `baselineDays`).
 */
export function spendSpikeRatio(
	last24hSpendUsd: number,
	trailingDailyAvgUsd: number,
): number {
	if (last24hSpendUsd < SPEND_SPIKE.minUsd) return 0;
	if (trailingDailyAvgUsd <= 0) return 0;
	return last24hSpendUsd / (SPEND_SPIKE.multiplier * trailingDailyAvgUsd);
}

/** Fraction of the cumulative upgraded-runtime cap used since the last operator reset. */
export function upgradeCapNearRatio(upgradedMs: number, capMs: number): number {
	return capMs <= 0 ? 0 : upgradedMs / capMs;
}

export interface UpgradeIdleInput {
	isUpgraded: boolean;
	/** From the disk sampler's latest `missionResources` reading; null if no recent sample exists. */
	runningJobs: number | null;
	/** Last turn activity for any agent in the mission; null if never observed. */
	lastActivityAt: Date | null;
	now: Date;
	idleMinutesThreshold: number;
}

/**
 * `idleMinutes / idleMinutesThreshold` for a currently-upgraded machine with
 * no running job; 0 (never fires) if the mission isn't upgraded, a job is
 * running, or there's no activity timestamp to measure idleness from — a
 * missing sample must never be read as "definitely idle."
 */
export function upgradeIdleRatio(input: UpgradeIdleInput): number {
	if (!input.isUpgraded) return 0;
	if (input.runningJobs === null || input.runningJobs > 0) return 0;
	if (input.lastActivityAt === null) return 0;
	const idleMinutes =
		(input.now.getTime() - input.lastActivityAt.getTime()) / 60_000;
	return idleMinutes / input.idleMinutesThreshold;
}
