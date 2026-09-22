/**
 * Every resource-oversight threshold and machine-upgrade limit, in one place
 * (ADR-0031, ADR-0032). Imported by the daemon (disk sampler) and the control
 * plane (upgrade route, monitor tick, daily report) so a number is only ever
 * changed once. Deliberately constants, not configuration: nothing here is
 * reachable from an agent tool or an environment variable.
 *
 * Ratios are fractions of the limit (0.8 = 80%).
 */

export interface LevelThresholds {
	/** At or above this: a soft alert (recorded, reported, not relayed). */
	readonly soft: number;
	/** At or above this: a hard alert (also relayed to the control-plane copilot). */
	readonly hard: number;
}

/** Per-mission Fly Volume usage. */
export const DISK_USAGE: LevelThresholds = { soft: 0.8, hard: 0.9 };

/** Shared MongoDB Atlas cluster storage, across all databases. */
export const ATLAS_STORAGE: LevelThresholds = { soft: 0.7, hard: 0.85 };

/** Lifetime LLM spend against the mission's spend cap. */
export const SPEND_CAP: LevelThresholds = { soft: 0.9, hard: 0.98 };

/** `spend-spike`: 24 h spend above `multiplier` × the trailing daily average, and above `minUsd`. */
export const SPEND_SPIKE = {
	multiplier: 3,
	minUsd: 5,
	windowHours: 24,
	baselineDays: 7,
} as const;

/** `upgrade-cap-near` fires at this fraction of the cumulative upgraded-runtime cap. */
export const UPGRADE_CAP_NEAR_RATIO = 0.8;

/**
 * `upgrade-cap-near` as a `LevelThresholds` pair for `evaluateAlert`, soft only
 * (ADR-0032: this category never escalates to hard — cap-reached is a
 * separate, already-relayed category). `hard` is unreachable by construction.
 */
export const UPGRADE_CAP_NEAR: LevelThresholds = {
	soft: UPGRADE_CAP_NEAR_RATIO,
	hard: Number.POSITIVE_INFINITY,
};

/** `upgrade-idle`: an upgraded machine with no conversation activity and no running job for this long. */
export const UPGRADE_IDLE_MINUTES = 30;

/**
 * `upgrade-idle` as a `LevelThresholds` pair, evaluated against
 * `idleMinutes / UPGRADE_IDLE_MINUTES` so 1.0 is "idle for the full window."
 * Soft only, same reasoning as `UPGRADE_CAP_NEAR`.
 */
export const UPGRADE_IDLE: LevelThresholds = {
	soft: 1,
	hard: Number.POSITIVE_INFINITY,
};

/**
 * `spend-spike` as a `LevelThresholds` pair, evaluated against
 * `last24hSpend / (SPEND_SPIKE.multiplier * trailingDailyAverage)` so 1.0 is
 * exactly at the multiplier. Soft only — ADR-0032 never escalates a spike to
 * hard (the mission's own spend cap, `SPEND_CAP`, is the hard stop).
 */
export const SPEND_SPIKE_RATIO: LevelThresholds = {
	soft: 1,
	hard: Number.POSITIVE_INFINITY,
};

/** Ratio must fall this far below a threshold before its alert state is forgotten (no flapping). */
export const ALERT_CLEAR_HYSTERESIS = 0.05;

/** An alert that stays at the same level is repeated after this long. */
export const ALERT_REPEAT_HOURS = 24;

/** Daily-report flags that are not simply "an alert threshold is crossed". */
export const REPORT_FLAGS = {
	spendCapRatio: 0.8,
	diskFullWithinDays: 7,
	/** Upgraded on at least this many of the last `chronicUpgradeWindowDays` daily snapshots. */
	chronicUpgradeDays: 5,
	chronicUpgradeWindowDays: 7,
	/** A running mission whose resource sample is older than this is "monitoring blind". */
	staleSampleMinutes: 5,
} as const;

/** Atlas M0 storage limit, used when `ATLAS_STORAGE_LIMIT_MB` is not set. */
export const ATLAS_STORAGE_LIMIT_MB_DEFAULT = 512;

/** Temporary machine upgrades (ADR-0031). */
export const UPGRADE_LIMITS = {
	/** Cumulative time on a non-default machine before the operator must reset it. */
	cumulativeCapHours: 24,
	maxCpus: 4,
	maxMemoryMb: 16_384,
	/** Longest single window; the duration is mandatory, there is no default. */
	maxWindowMinutes: 60,
	/** Minimum gap between resizes to a different shape (or a revert). Same-shape renewals are exempt. */
	resizeCooldownMinutes: 5,
	/** A resize claim older than this is treated as a failed resize. */
	staleClaimMinutes: 5,
	/** How long before expiry the renewal reminder is delivered. */
	reminderBufferMinutes: 10,
	/** Agent-authored `reason` text is cut to this length before it reaches an operator or copilot. */
	reasonMaxChars: 500,
} as const;
