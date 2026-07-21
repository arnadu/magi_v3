/**
 * Agent statistics — Sprint 24.
 *
 * A three-layer statistics model that powers budget limits (Sprint 24), file
 * tracking (Sprint 25), and the outcome cockpit / trace viewer (Sprint 26):
 *
 *   - Per call    → `llmCallLog` (existing; raw audit trail, see llm-call-log.ts)
 *   - Per turn    → `agentTurnStats` (this module; one doc per agent wakeup)
 *   - Mission     → `missionStats` (this module; lifetime totals per agent)
 *
 * One `runAgent` call == one turn == one wakeup; `turnNumber` is the conversation
 * turn from ConversationRepository.
 *
 * Persistence is INCREMENTAL: `agentTurnStats` is upserted on every inner-loop
 * iteration (each LLM call and each tool result), keyed by
 * (missionId, agentId, turnNumber). A paused or crashed machine therefore loses
 * at most the current in-flight iteration, and a running turn is visible live to
 * the trace viewer. `missionStats` is incremented with `$inc` ONLY at turn end —
 * incrementing it per-iteration would double-count if a turn is replayed after a
 * restart, whereas an incomplete turn (one that never reached `endTurn`) never
 * contributed to the lifetime totals.
 *
 * The limits module reads the in-memory turn accumulator (`getTurn`) for the
 * turn currently in flight — that's a write-side staging buffer for the turn
 * doc, not a cache of anything durable, so it's always exactly as fresh as the
 * in-progress turn itself. Lifetime totals are a different matter: anything
 * checked against a limit reads `missionStats` FRESH from MongoDB at decision
 * time via `readLifetime()` / `readMissionSnapshot()` — there is deliberately
 * no in-memory cache of lifetime totals. An earlier version of this module
 * cached lifetime totals in memory (loaded once per daemon lifetime); that
 * cache was the root cause of a production bug where a mission's true spend
 * ($60+) was checked against a stale in-memory value ($7) after a daemon
 * restart. A DB read (low single-digit ms) is negligible next to LLM call
 * latency (seconds), so there is no real performance case for caching
 * verification-critical data — the correctness gained by never trusting a
 * cache is worth far more than the round-trip saved. Do not reintroduce one.
 *
 * Collections: `agentTurnStats`, `missionStats`.
 */

import type { Db } from "mongodb";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

/** Token/cost figures for a single LLM call, fed to the collector. */
export interface LlmCallStats {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
}

/** Tool-result facts fed to the collector after each tool execution. */
export interface ToolResultStats {
	toolName: string;
	/** The tool-call arguments (used to extract file paths, recipients, URLs). */
	args: Record<string, unknown>;
	isError: boolean;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface AgentStatsRepository {
	/** Upsert the full turn document (keyed by missionId/agentId/turnNumber). */
	upsertTurn(stats: AgentTurnStats): Promise<void>;
	/** Apply lifetime deltas to a mission-stats doc; returns the new totals. */
	incrementMission(delta: {
		missionId: string;
		agentId: string;
		costUsd: number;
		llmCallCount: number;
		/** Replaces (does not increment) consecutiveZeroOutputTurns. */
		consecutiveZeroOutputTurns: number;
		lastTurnAt: Date;
	}): Promise<MissionStats>;
	/** Load lifetime totals for an agent, or null if none recorded yet. */
	loadMission(missionId: string, agentId: string): Promise<MissionStats | null>;
	/**
	 * Apply a lifetime cost delta outside the normal turn lifecycle (reflection
	 * calls have no turn to attribute to). Unlike `incrementMission`, does not
	 * touch `lifetimeTurnCount` or `consecutiveZeroOutputTurns`.
	 */
	incrementLifetimeCostOnly(delta: {
		missionId: string;
		agentId: string;
		costUsd: number;
		llmCallCount: number;
	}): Promise<MissionStats>;
	/**
	 * Snapshot every agent's persisted lifetime cost plus any currently in-flight
	 * turn's cost so far, for a mission-wide total. Always reads fresh from
	 * `missionStats` + `agentTurnStats` — never cached.
	 */
	readMissionSnapshot(
		missionId: string,
	): Promise<
		Array<{ agentId: string; lifetimeCostUsd: number; turnCostUsd: number }>
	>;
	/** Query turn docs for a mission, ascending by turnNumber. */
	queryTurns(filter: {
		missionId: string;
		agentId?: string;
	}): Promise<AgentTurnStats[]>;
	/**
	 * Mark any OTHER turn for this agent still stuck at status:'running' as
	 * 'aborted'. Called at the start of a new turn — the orchestrator's `active`
	 * map guarantees only one turn per agent is ever genuinely in flight, so a
	 * new turn starting is proof any earlier 'running' doc is stale (its process
	 * died, crashed, or hung past every timeout without the normal endTurn
	 * finalize path ever running). Returns the count reconciled.
	 */
	reconcileStaleRunning(
		missionId: string,
		agentId: string,
		currentTurnNumber: number,
	): Promise<number>;
}

export function createMongoAgentStatsRepository(db: Db): AgentStatsRepository {
	const turns = db.collection<AgentTurnStats & { _id?: unknown }>(
		"agentTurnStats",
	);
	const missions = db.collection<MissionStats & { _id?: unknown }>(
		"missionStats",
	);

	turns
		.createIndex({ missionId: 1, agentId: 1, turnNumber: 1 }, { unique: true })
		.catch((e: unknown) =>
			console.warn(
				"[agent-stats] Failed to create agentTurnStats index:",
				(e as Error).message,
			),
		);
	missions
		.createIndex({ missionId: 1, agentId: 1 }, { unique: true })
		.catch((e: unknown) =>
			console.warn(
				"[agent-stats] Failed to create missionStats index:",
				(e as Error).message,
			),
		);

	return {
		async upsertTurn(stats) {
			const { missionId, agentId, turnNumber } = stats;
			await turns.updateOne(
				{ missionId, agentId, turnNumber },
				{ $set: stats },
				{ upsert: true },
			);
		},

		async incrementMission(delta) {
			const { missionId, agentId } = delta;
			const result = await missions.findOneAndUpdate(
				{ missionId, agentId },
				{
					$inc: {
						lifetimeCostUsd: delta.costUsd,
						lifetimeLlmCallCount: delta.llmCallCount,
						lifetimeTurnCount: 1,
					},
					$set: {
						consecutiveZeroOutputTurns: delta.consecutiveZeroOutputTurns,
						lastTurnAt: delta.lastTurnAt,
					},
					$setOnInsert: { missionId, agentId },
				},
				{ upsert: true, returnDocument: "after" },
			);
			// returnDocument:"after" guarantees a document; fall back defensively.
			const doc = result as MissionStats | null;
			return (
				doc ?? {
					missionId,
					agentId,
					lifetimeCostUsd: delta.costUsd,
					lifetimeLlmCallCount: delta.llmCallCount,
					lifetimeTurnCount: 1,
					consecutiveZeroOutputTurns: delta.consecutiveZeroOutputTurns,
					lastTurnAt: delta.lastTurnAt,
				}
			);
		},

		async loadMission(missionId, agentId) {
			const doc = await missions.findOne({ missionId, agentId });
			if (!doc) return null;
			const { _id: _discarded, ...rest } = doc;
			return rest as MissionStats;
		},

		async incrementLifetimeCostOnly(delta) {
			const { missionId, agentId } = delta;
			const result = await missions.findOneAndUpdate(
				{ missionId, agentId },
				{
					$inc: {
						lifetimeCostUsd: delta.costUsd,
						lifetimeLlmCallCount: delta.llmCallCount,
					},
					$setOnInsert: {
						missionId,
						agentId,
						lifetimeTurnCount: 0,
						consecutiveZeroOutputTurns: 0,
						lastTurnAt: new Date(),
					},
				},
				{ upsert: true, returnDocument: "after" },
			);
			const doc = result as MissionStats | null;
			return (
				doc ?? {
					missionId,
					agentId,
					lifetimeCostUsd: delta.costUsd,
					lifetimeLlmCallCount: delta.llmCallCount,
					lifetimeTurnCount: 0,
					consecutiveZeroOutputTurns: 0,
					lastTurnAt: new Date(),
				}
			);
		},

		async readMissionSnapshot(missionId) {
			const [lifetimeDocs, runningTurns] = await Promise.all([
				missions.find({ missionId }).toArray(),
				turns.find({ missionId, status: "running" }).toArray(),
			]);
			const turnCostByAgent = new Map<string, number>();
			for (const t of runningTurns) {
				turnCostByAgent.set(
					t.agentId,
					(turnCostByAgent.get(t.agentId) ?? 0) + t.costUsd,
				);
			}
			const agentIds = new Set<string>([
				...lifetimeDocs.map((d) => d.agentId),
				...turnCostByAgent.keys(),
			]);
			return [...agentIds].map((agentId) => ({
				agentId,
				lifetimeCostUsd:
					lifetimeDocs.find((d) => d.agentId === agentId)?.lifetimeCostUsd ?? 0,
				turnCostUsd: turnCostByAgent.get(agentId) ?? 0,
			}));
		},

		async queryTurns(filter) {
			const q: Record<string, unknown> = { missionId: filter.missionId };
			if (filter.agentId !== undefined) q.agentId = filter.agentId;
			const docs = await turns.find(q).sort({ turnNumber: 1 }).toArray();
			return docs.map(({ _id: _discarded, ...rest }) => rest as AgentTurnStats);
		},

		async reconcileStaleRunning(missionId, agentId, currentTurnNumber) {
			const result = await turns.updateMany(
				{
					missionId,
					agentId,
					status: "running",
					turnNumber: { $ne: currentTurnNumber },
				},
				{ $set: { status: "aborted", completedAt: new Date() } },
			);
			return result.modifiedCount;
		},
	};
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

/** File-writing tools whose `path` argument is recorded as a touched file. */
const FILE_WRITE_TOOLS = new Set(["WriteFile", "EditFile"]);
/** Tools whose `url` argument is recorded as a visited URL. */
const URL_TOOLS = new Set(["FetchUrl", "BrowseWeb"]);

function freshTurn(
	missionId: string,
	agentId: string,
	turnNumber: number,
	reflectionTriggered: boolean,
): AgentTurnStats {
	return {
		missionId,
		agentId,
		turnNumber,
		startedAt: new Date(),
		status: "running",
		llmCallCount: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
		peakContextTokens: 0,
		toolCalls: {},
		toolErrors: {},
		filesWritten: [],
		messagesSent: [],
		urlsVisited: [],
		reflectionTriggered,
	};
}

/**
 * Stateful per-agent statistics aggregator. One instance per daemon; it manages
 * in-memory state keyed by agentId so concurrent agents do not contend.
 *
 * Lifecycle per turn:
 *   startTurn() → recordLlmCall()/recordToolResult() (repeated) → endTurn()
 *
 * All record methods update the in-memory accumulator synchronously and persist
 * the turn document; persistence failures are logged but never throw into the
 * agent loop (statistics must not break a mission).
 */
export class StatsCollector {
	private readonly turns = new Map<string, AgentTurnStats>();

	constructor(private readonly repo: AgentStatsRepository) {}

	private key(agentId: string): string {
		return agentId;
	}

	/** Begin a new turn. Resets the in-memory turn accumulator. */
	async startTurn(
		missionId: string,
		agentId: string,
		turnNumber: number,
		reflectionTriggered: boolean,
	): Promise<void> {
		const turn = freshTurn(missionId, agentId, turnNumber, reflectionTriggered);
		this.turns.set(this.key(agentId), turn);

		// Best-effort: reconcile any earlier turn for this agent still stuck at
		// 'running' — a new turn starting proves it's stale (see
		// reconcileStaleRunning's doc comment). Must never block/break this turn.
		try {
			const reconciled = await this.repo.reconcileStaleRunning(
				missionId,
				agentId,
				turnNumber,
			);
			if (reconciled > 0) {
				console.warn(
					`[agent-stats] reconciled ${reconciled} stale 'running' turn(s) for ${agentId} in ${missionId}`,
				);
			}
		} catch (e) {
			console.error(
				`[agent-stats] reconcileStaleRunning failed { missionId: ${missionId}, agentId: ${agentId} }: ${(e as Error).message}`,
			);
		}

		await this.persist(agentId);
	}

	/** Accumulate one LLM call and persist. */
	async recordLlmCall(agentId: string, stats: LlmCallStats): Promise<void> {
		const turn = this.turns.get(this.key(agentId));
		if (!turn) return;
		turn.llmCallCount += 1;
		turn.inputTokens += stats.inputTokens;
		turn.outputTokens += stats.outputTokens;
		turn.cacheReadTokens += stats.cacheReadTokens;
		turn.cacheWriteTokens += stats.cacheWriteTokens;
		turn.costUsd += stats.costUsd;
		const contextTokens =
			stats.inputTokens + stats.cacheReadTokens + stats.cacheWriteTokens;
		if (contextTokens > turn.peakContextTokens) {
			turn.peakContextTokens = contextTokens;
		}
		await this.persist(agentId);
	}

	/** Accumulate one tool result and persist. */
	async recordToolResult(
		agentId: string,
		stats: ToolResultStats,
	): Promise<void> {
		const turn = this.turns.get(this.key(agentId));
		if (!turn) return;
		const { toolName, args, isError } = stats;
		turn.toolCalls[toolName] = (turn.toolCalls[toolName] ?? 0) + 1;
		if (isError) {
			turn.toolErrors[toolName] = (turn.toolErrors[toolName] ?? 0) + 1;
		}

		if (FILE_WRITE_TOOLS.has(toolName) && typeof args.path === "string") {
			turn.filesWritten.push({ path: args.path, tool: toolName });
		}
		if (toolName === "PostMessage") {
			const to = Array.isArray(args.to)
				? (args.to.filter((t) => typeof t === "string") as string[])
				: [];
			const subject = typeof args.subject === "string" ? args.subject : "";
			turn.messagesSent.push({ to, subject });
		}
		if (URL_TOOLS.has(toolName) && typeof args.url === "string") {
			turn.urlsVisited.push(args.url);
		}
		await this.persist(agentId);
	}

	/**
	 * Finalize the turn: mark complete/aborted, write the final turn doc, and
	 * increment lifetime totals in `missionStats` (exactly once per turn).
	 */
	async endTurn(
		agentId: string,
		status: "complete" | "aborted" = "complete",
		git?: { commit: string; changedFiles: { path: string; status: string }[] },
	): Promise<void> {
		const turn = this.turns.get(this.key(agentId));
		if (!turn) return;
		turn.completedAt = new Date();
		turn.durationSeconds = Math.max(
			0,
			(turn.completedAt.getTime() - turn.startedAt.getTime()) / 1000,
		);
		turn.status = status;
		if (git) {
			turn.gitCommit = git.commit;
			turn.gitChangedFiles = git.changedFiles;
		}
		await this.persist(agentId);

		const producedOutput =
			turn.filesWritten.length > 0 || turn.messagesSent.length > 0;

		try {
			const prior = await this.repo.loadMission(turn.missionId, agentId);
			const consecutiveZeroOutputTurns = producedOutput
				? 0
				: (prior?.consecutiveZeroOutputTurns ?? 0) + 1;
			await this.repo.incrementMission({
				missionId: turn.missionId,
				agentId,
				costUsd: turn.costUsd,
				llmCallCount: turn.llmCallCount,
				consecutiveZeroOutputTurns,
				lastTurnAt: turn.completedAt,
			});
		} catch (e) {
			console.error(
				`[agent-stats] failed to increment missionStats { missionId: ${turn.missionId}, agentId: ${agentId}, turnNumber: ${turn.turnNumber} }: ${(e as Error).message}`,
			);
		}

		this.turns.delete(this.key(agentId));
	}

	/** Current in-memory turn accumulator (for limit checks). */
	getTurn(agentId: string): Readonly<AgentTurnStats> | undefined {
		return this.turns.get(this.key(agentId));
	}

	/**
	 * Read lifetime totals fresh from `missionStats` — never cached. Callers
	 * that need restart-durable, always-correct totals (limit checks, cost
	 * attribution) must use this instead of any in-memory value.
	 */
	async readLifetime(
		missionId: string,
		agentId: string,
	): Promise<Readonly<MissionStats> | null> {
		return this.repo.loadMission(missionId, agentId);
	}

	/**
	 * Snapshot every agent's persisted lifetime cost plus in-flight turn cost,
	 * fresh from MongoDB — the basis for the mission-wide spend cap.
	 */
	async readMissionSnapshot(
		missionId: string,
	): Promise<
		Array<{ agentId: string; lifetimeCostUsd: number; turnCostUsd: number }>
	> {
		return this.repo.readMissionSnapshot(missionId);
	}

	/**
	 * Record a reflection call's cost against lifetime totals. Reflection runs
	 * outside the normal turn lifecycle (it happens before `startTurn`), so this
	 * bypasses the turn-based increment entirely rather than waiting for endTurn.
	 */
	async recordReflectionCost(
		missionId: string,
		agentId: string,
		costUsd: number,
	): Promise<void> {
		try {
			await this.repo.incrementLifetimeCostOnly({
				missionId,
				agentId,
				costUsd,
				llmCallCount: 1,
			});
		} catch (e) {
			console.error(
				`[agent-stats] failed to record reflection cost { missionId: ${missionId}, agentId: ${agentId} }: ${(e as Error).message}`,
			);
		}
	}

	private async persist(agentId: string): Promise<void> {
		const turn = this.turns.get(this.key(agentId));
		if (!turn) return;
		try {
			await this.repo.upsertTurn(turn);
		} catch (e) {
			console.error(
				`[agent-stats] failed to upsert agentTurnStats { missionId: ${turn.missionId}, agentId: ${agentId}, turnNumber: ${turn.turnNumber} }: ${(e as Error).message}`,
			);
		}
	}
}
