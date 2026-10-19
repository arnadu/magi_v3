/**
 * `agentTurnStats` (one doc per agent wakeup, upserted incrementally during
 * the turn) and `missionStats` (lifetime totals per agent, `$inc`-ed once at
 * turn end). Written by the worker's StatsCollector (agent-stats.ts); read by
 * limits, the cockpit trace/transcript routes, the mission summary and the
 * copilots. `llmCallLog` is pruned after its retention window; these are not,
 * so anything lifetime (spend caps, usage totals) reads them.
 */

/** A file touched by a write/edit tool during a turn. */
export interface TouchedFile {
	path: string;
	tool: string;
}

/** A message posted to other agents or the user during a turn. */
export interface SentMessage {
	to: string[];
	subject: string;
}

/**
 * Per-turn statistics. Persisted to `agentTurnStats`, keyed by
 * (missionId, agentId, turnNumber). Upserted incrementally; finalized at turn end.
 */
export interface AgentTurnStats {
	missionId: string;
	agentId: string;
	turnNumber: number;
	startedAt: Date;
	/** Set at turn end. Absent while the turn is running. */
	completedAt?: Date;
	/** Wall-clock duration in seconds. Set at turn end. */
	durationSeconds?: number;
	status: "running" | "complete" | "aborted";

	// LLM aggregates
	llmCallCount: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	/** Max per-call context size (input + cacheRead + cacheWrite) across the turn. */
	peakContextTokens: number;

	// Tool aggregates
	toolCalls: Record<string, number>;
	toolErrors: Record<string, number>;

	// Output signals
	filesWritten: TouchedFile[];
	messagesSent: SentMessage[];
	urlsVisited: string[];
	/** True when reflection ran at the start of this wakeup. */
	reflectionTriggered: boolean;

	// Git checkpoint (Sprint 25) — set at turn end when the workspace changed.
	/** Commit SHA of the workspace checkpoint taken at this turn's end. */
	gitCommit?: string;
	/**
	 * Files changed in `gitCommit` (status letter + path). Captures Bash-/skill-
	 * written files that `filesWritten` (WriteFile/EditFile only) cannot see.
	 * This is the workspace delta since the previous commit, so it may include
	 * changes from other agents whose turns overlapped.
	 */
	gitChangedFiles?: { path: string; status: string }[];
}

/**
 * Lifetime totals per (missionId, agentId). Persisted to `missionStats`.
 * Updated with `$inc` at turn end only.
 */
export interface MissionStats {
	missionId: string;
	agentId: string;
	lifetimeCostUsd: number;
	lifetimeLlmCallCount: number;
	lifetimeTurnCount: number;
	/**
	 * Consecutive turns that produced no files and sent no messages. Reset to 0
	 * when a turn produces output. A stuck-agent signal for the copilot.
	 */
	consecutiveZeroOutputTurns: number;
	lastTurnAt: Date;
}
