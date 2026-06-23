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
 * The limits module (added later in Sprint 24) reads the in-memory accumulator
 * exposed by `getTurn` / `getLifetime` — there is no DB query in the enforcement
 * hot path. Lifetime totals are reloaded from `missionStats` on the first turn an
 * agent runs after a daemon restart, so caps survive restarts.
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
	/** Query turn docs for a mission, ascending by turnNumber. */
	queryTurns(filter: {
		missionId: string;
		agentId?: string;
	}): Promise<AgentTurnStats[]>;
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

		async queryTurns(filter) {
			const q: Record<string, unknown> = { missionId: filter.missionId };
			if (filter.agentId !== undefined) q.agentId = filter.agentId;
			const docs = await turns.find(q).sort({ turnNumber: 1 }).toArray();
			return docs.map(({ _id: _discarded, ...rest }) => rest as AgentTurnStats);
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
	private readonly lifetimes = new Map<string, MissionStats>();

	constructor(private readonly repo: AgentStatsRepository) {}

	private key(agentId: string): string {
		return agentId;
	}

	/**
	 * Begin a new turn. Resets the in-memory turn accumulator and loads lifetime
	 * totals from `missionStats` if not already cached (survives daemon restart).
	 */
	async startTurn(
		missionId: string,
		agentId: string,
		turnNumber: number,
		reflectionTriggered: boolean,
	): Promise<void> {
		const turn = freshTurn(missionId, agentId, turnNumber, reflectionTriggered);
		this.turns.set(this.key(agentId), turn);

		if (!this.lifetimes.has(this.key(agentId))) {
			try {
				const loaded = await this.repo.loadMission(missionId, agentId);
				if (loaded) this.lifetimes.set(this.key(agentId), loaded);
			} catch (e) {
				console.error(
					`[agent-stats] failed to load missionStats { missionId: ${missionId}, agentId: ${agentId} }: ${(e as Error).message}`,
				);
			}
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
	): Promise<void> {
		const turn = this.turns.get(this.key(agentId));
		if (!turn) return;
		turn.completedAt = new Date();
		turn.durationSeconds = Math.max(
			0,
			(turn.completedAt.getTime() - turn.startedAt.getTime()) / 1000,
		);
		turn.status = status;
		await this.persist(agentId);

		const producedOutput =
			turn.filesWritten.length > 0 || turn.messagesSent.length > 0;
		const prior = this.lifetimes.get(this.key(agentId));
		const consecutiveZeroOutputTurns = producedOutput
			? 0
			: (prior?.consecutiveZeroOutputTurns ?? 0) + 1;

		try {
			const updated = await this.repo.incrementMission({
				missionId: turn.missionId,
				agentId,
				costUsd: turn.costUsd,
				llmCallCount: turn.llmCallCount,
				consecutiveZeroOutputTurns,
				lastTurnAt: turn.completedAt,
			});
			this.lifetimes.set(this.key(agentId), updated);
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

	/** Cached lifetime totals (for limit checks). */
	getLifetime(agentId: string): Readonly<MissionStats> | undefined {
		return this.lifetimes.get(this.key(agentId));
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
