/**
 * Limits framework — Sprint 24 phase 2.
 *
 * Decouples *what is measured* (the StatsCollector, see agent-stats.ts) from
 * *what to do about it*. A `LimitRule[]` table is evaluated against the
 * collector's in-memory turn + lifetime accumulators — no DB query in the
 * enforcement hot path.
 *
 * Two enforcement classes:
 *   - HARD limits are enforced mechanically: a breach throws `LimitExceededError`
 *     out of the agent's inner-loop hook, aborting the turn immediately. Hard
 *     limits are OPT-IN (configured per agent) so an existing mission's
 *     legitimate long turn is never aborted by a surprise default.
 *   - SOFT limits are advisory: a breach fires an alert routed to the copilot
 *     (and the monitor dashboard) for context-dependent judgement — high call
 *     counts can be legitimate. Soft limits ship with conservative defaults so
 *     observability works out of the box with zero behaviour change.
 *
 * This module is pure: `evaluateLimits` takes plain snapshots and returns
 * breaches. It performs no I/O and is fully unit-testable.
 */

import type { AgentTurnStats, MissionStats } from "./agent-stats.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metrics a rule can be evaluated against, grouped by the window they read. */
export type LimitMetric =
	// turn window (from AgentTurnStats)
	| "llmCallCount"
	| "costUsd"
	| "peakContextTokens"
	| "toolErrors"
	// lifetime window (from MissionStats)
	| "lifetimeCostUsd"
	| "consecutiveZeroOutputTurns";

const TURN_METRICS: ReadonlySet<LimitMetric> = new Set<LimitMetric>([
	"llmCallCount",
	"costUsd",
	"peakContextTokens",
	"toolErrors",
]);

export interface LimitRule {
	/** Stable id, e.g. "hard:maxLlmCallsPerTurn" — used to dedupe soft alerts. */
	id: string;
	metric: LimitMetric;
	/** Breach when the metric value is strictly greater than this threshold. */
	threshold: number;
	/**
	 * hard → throw LimitExceededError (abort the turn);
	 * soft → fire an advisory alert, do not interrupt the turn.
	 */
	severity: "hard" | "soft";
	/** Human-readable explanation included in alerts and the thrown error. */
	label: string;
}

export interface LimitBreach {
	rule: LimitRule;
	/** The observed metric value that breached the threshold. */
	value: number;
}

/** A breach contextualized with the agent and turn it occurred on, for routing. */
export interface LimitAlert {
	agentId: string;
	turnNumber: number;
	breach: LimitBreach;
}

/**
 * Thrown out of an inner-loop hook when a HARD limit is breached. The agent
 * runner catches it, finalizes the turn as aborted, and routes an alert —
 * it is not a crash.
 */
export class LimitExceededError extends Error {
	constructor(readonly breach: LimitBreach) {
		super(
			`Hard limit "${breach.rule.id}" exceeded: ${breach.rule.metric}=${breach.value} > ${breach.rule.threshold} (${breach.rule.label})`,
		);
		this.name = "LimitExceededError";
	}
}

// ---------------------------------------------------------------------------
// Config → rules
// ---------------------------------------------------------------------------

/**
 * Per-agent limit configuration (the YAML `limits` block). All fields optional.
 * Hard fields, when set, abort the turn; soft fields override the conservative
 * built-in soft defaults (set a soft field to 0 to disable that soft rule).
 */
export interface LimitConfig {
	// hard (opt-in; no default — absent means no hard enforcement)
	maxLlmCallsPerTurn?: number;
	maxCostPerTurnUsd?: number;
	maxLifetimeCostUsd?: number;
	// soft (defaulted; advisory)
	warnLlmCallsPerTurn?: number;
	warnPeakContextTokens?: number;
	warnToolErrorsPerTurn?: number;
	warnConsecutiveZeroOutputTurns?: number;
}

/**
 * Conservative soft defaults — chosen to fire only on genuinely anomalous turns
 * (the records-officer that motivated this work ran 47 LLM calls in one turn).
 * A soft breach only routes an alert; it never changes behaviour. Set the
 * corresponding config field to 0 to disable a default.
 */
export const DEFAULT_SOFT_LIMITS = {
	warnLlmCallsPerTurn: 40,
	warnPeakContextTokens: 160_000, // matches the in-session prune threshold
	warnToolErrorsPerTurn: 8,
	warnConsecutiveZeroOutputTurns: 3,
} as const;

/** A positive number, or undefined if the value is missing or <= 0 (disabled). */
function positive(n: number | undefined): number | undefined {
	return typeof n === "number" && n > 0 ? n : undefined;
}

/**
 * Build the active rule set for an agent from its config, layering the soft
 * defaults underneath any explicit overrides. Hard rules appear only when
 * explicitly configured.
 */
export function buildRules(config: LimitConfig = {}): LimitRule[] {
	const rules: LimitRule[] = [];

	// ── hard (opt-in) ────────────────────────────────────────────────────────
	const maxCalls = positive(config.maxLlmCallsPerTurn);
	if (maxCalls !== undefined) {
		rules.push({
			id: "hard:maxLlmCallsPerTurn",
			metric: "llmCallCount",
			threshold: maxCalls,
			severity: "hard",
			label: "too many LLM calls in a single turn",
		});
	}
	const maxTurnCost = positive(config.maxCostPerTurnUsd);
	if (maxTurnCost !== undefined) {
		rules.push({
			id: "hard:maxCostPerTurnUsd",
			metric: "costUsd",
			threshold: maxTurnCost,
			severity: "hard",
			label: "turn cost cap reached",
		});
	}
	const maxLifetimeCost = positive(config.maxLifetimeCostUsd);
	if (maxLifetimeCost !== undefined) {
		rules.push({
			id: "hard:maxLifetimeCostUsd",
			metric: "lifetimeCostUsd",
			threshold: maxLifetimeCost,
			severity: "hard",
			label: "per-agent lifetime cost cap reached",
		});
	}

	// ── soft (defaulted; 0 disables) ──────────────────────────────────────────
	const warnCalls = positive(
		config.warnLlmCallsPerTurn ?? DEFAULT_SOFT_LIMITS.warnLlmCallsPerTurn,
	);
	if (warnCalls !== undefined) {
		rules.push({
			id: "soft:warnLlmCallsPerTurn",
			metric: "llmCallCount",
			threshold: warnCalls,
			severity: "soft",
			label: "unusually many LLM calls in one turn (possible runaway autonomy)",
		});
	}
	const warnCtx = positive(
		config.warnPeakContextTokens ?? DEFAULT_SOFT_LIMITS.warnPeakContextTokens,
	);
	if (warnCtx !== undefined) {
		rules.push({
			id: "soft:warnPeakContextTokens",
			metric: "peakContextTokens",
			threshold: warnCtx,
			severity: "soft",
			label: "context size approaching the window limit",
		});
	}
	const warnErrors = positive(
		config.warnToolErrorsPerTurn ?? DEFAULT_SOFT_LIMITS.warnToolErrorsPerTurn,
	);
	if (warnErrors !== undefined) {
		rules.push({
			id: "soft:warnToolErrorsPerTurn",
			metric: "toolErrors",
			threshold: warnErrors,
			severity: "soft",
			label: "many tool errors in one turn (agent may be stuck)",
		});
	}
	const warnZero = positive(
		config.warnConsecutiveZeroOutputTurns ??
			DEFAULT_SOFT_LIMITS.warnConsecutiveZeroOutputTurns,
	);
	if (warnZero !== undefined) {
		rules.push({
			id: "soft:warnConsecutiveZeroOutputTurns",
			metric: "consecutiveZeroOutputTurns",
			threshold: warnZero,
			severity: "soft",
			label: "consecutive turns with no files or messages (agent may be stuck)",
		});
	}

	return rules;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Sum of all per-tool error counts in a turn. */
function totalToolErrors(turn: Pick<AgentTurnStats, "toolErrors">): number {
	return Object.values(turn.toolErrors).reduce((a, b) => a + b, 0);
}

/** Resolve a metric to its current value from the turn / lifetime snapshots. */
function metricValue(
	metric: LimitMetric,
	turn: AgentTurnStats,
	lifetime: MissionStats | undefined,
): number {
	switch (metric) {
		case "llmCallCount":
			return turn.llmCallCount;
		case "costUsd":
			return turn.costUsd;
		case "peakContextTokens":
			return turn.peakContextTokens;
		case "toolErrors":
			return totalToolErrors(turn);
		case "lifetimeCostUsd":
			// In-turn lifetime = persisted lifetime (prior turns) + this turn so far,
			// so a per-agent cost cap can trip mid-turn rather than only at turn end.
			return (lifetime?.lifetimeCostUsd ?? 0) + turn.costUsd;
		case "consecutiveZeroOutputTurns":
			return lifetime?.consecutiveZeroOutputTurns ?? 0;
	}
}

/**
 * Evaluate all rules against the current turn + lifetime snapshots. Returns
 * every breach (value strictly greater than threshold). Pure; no I/O.
 *
 * `consecutiveZeroOutputTurns` is a cross-turn signal only meaningful at turn
 * end; callers evaluating mid-turn should pass turn-window rules only (see
 * `window` helpers) — `evaluateLimits` itself evaluates whatever rules it is
 * given.
 */
export function evaluateLimits(
	turn: AgentTurnStats,
	lifetime: MissionStats | undefined,
	rules: LimitRule[],
): LimitBreach[] {
	const breaches: LimitBreach[] = [];
	for (const rule of rules) {
		const value = metricValue(rule.metric, turn, lifetime);
		if (value > rule.threshold) breaches.push({ rule, value });
	}
	return breaches;
}

/** True when a rule reads only the turn-window (safe to evaluate mid-turn). */
export function isTurnMetric(metric: LimitMetric): boolean {
	return TURN_METRICS.has(metric);
}

/**
 * Sum lifetime + in-flight-turn cost across every agent in a mission, for the
 * mission-wide spend cap. Mirrors the `"lifetimeCostUsd"` case in
 * `metricValue` (persisted lifetime + this-turn-so-far), extended across
 * agents instead of within one. Pure; no I/O — callers obtain the snapshot via
 * `StatsCollector.readMissionSnapshot`, always freshly read from MongoDB.
 */
export function missionLifetimeCostUsd(
	snapshot: ReadonlyArray<{ lifetimeCostUsd: number; turnCostUsd: number }>,
): number {
	return snapshot.reduce(
		(sum, a) => sum + a.lifetimeCostUsd + a.turnCostUsd,
		0,
	);
}
