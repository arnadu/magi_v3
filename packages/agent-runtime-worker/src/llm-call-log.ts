/**
 * LLM call audit log — Sprint 9+.
 *
 * Every LLM call (regular agent turn AND reflection) is written here. Provides:
 *   - Cost accounting with correct cache pricing
 *   - Explainability: exact system prompt and message context sent to the model
 *   - Debugging: full response including tool calls and stop reason
 *   - Traceability: linked to agentId, missionId, turnNumber, isReflection flag
 *
 * Storage notes:
 *   - Tool result bodies are truncated to MAX_TOOL_BODY_CHARS to prevent bloat
 *     from large FetchUrl / BrowseWeb / Bash outputs.
 *   - System prompts are stored in full (5–15 kB each; they include the current
 *     Mental Map HTML which changes between sessions).
 *   - All documents are retained indefinitely; no compaction.
 *
 * Collection: `llmCallLog`
 */

import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { Db } from "mongodb";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tool result bodies beyond this length are truncated in the stored log. */
const MAX_TOOL_BODY_CHARS = 2_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A message as stored in the log — tool result bodies may be truncated. */
export type LoggedMessage = Message;

export interface LlmCallCost {
	inputCostUsd: number;
	outputCostUsd: number;
	cacheReadCostUsd: number;
	cacheWriteCostUsd: number;
	totalCostUsd: number;
}

export interface LlmCallUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: LlmCallCost;
}

/**
 * One log entry per LLM call.
 *
 * `input.messages` is the full context array sent to the model (with tool
 * result bodies truncated). Combined with `input.systemPrompt` this
 * reconstructs exactly what the model was shown at this call.
 */
export interface LlmCallLogEntry {
	missionId: string;
	agentId: string;
	/** Conversation turn number from ConversationRepository. */
	turnNumber: number;
	/** True for calls made by the reflection inner loop. */
	isReflection: boolean;
	savedAt: Date;
	/** Model id (e.g. "claude-sonnet-4-6"). */
	model: string;
	input: {
		systemPrompt: string;
		/** Full message context sent to the model (tool bodies truncated). */
		messages: LoggedMessage[];
		/** Names of tools made available on this call. */
		toolNames: string[];
	};
	output: {
		/** Full AssistantMessage returned by the model. */
		message: AssistantMessage;
		stopReason: string;
	};
	usage: LlmCallUsage;
}

export interface LlmCallLogRepository {
	append(entry: LlmCallLogEntry): Promise<void>;
	/**
	 * Query call log entries. All filters are optional and AND-ed together.
	 * Results are sorted by savedAt ascending.
	 */
	query(filter: {
		missionId?: string;
		agentId?: string;
		isReflection?: boolean;
		from?: Date;
		to?: Date;
	}): Promise<LlmCallLogEntry[]>;
}

// ---------------------------------------------------------------------------
// Cost calculation
// ---------------------------------------------------------------------------

/**
 * Compute per-component costs from raw token counts and model pricing.
 * The model object carries pricing per million tokens; cache pricing was
 * historically zeroed (bug in models.ts now fixed).
 *
 * @param usage - raw token counts from AssistantMessage.usage
 * @param modelCost - the `cost` field from the Model descriptor
 */
export function computeCost(
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
	modelCost: { input: number; output: number; cacheRead: number; cacheWrite: number },
): LlmCallCost {
	const perToken = (pricePerMillion: number) => pricePerMillion / 1_000_000;
	const inputCostUsd = usage.input * perToken(modelCost.input);
	const outputCostUsd = usage.output * perToken(modelCost.output);
	const cacheReadCostUsd = usage.cacheRead * perToken(modelCost.cacheRead);
	const cacheWriteCostUsd = usage.cacheWrite * perToken(modelCost.cacheWrite);
	return {
		inputCostUsd,
		outputCostUsd,
		cacheReadCostUsd,
		cacheWriteCostUsd,
		totalCostUsd: inputCostUsd + outputCostUsd + cacheReadCostUsd + cacheWriteCostUsd,
	};
}

// ---------------------------------------------------------------------------
// Message truncation
// ---------------------------------------------------------------------------

/**
 * Return a copy of the message array with large tool result bodies truncated.
 * All other message types are passed through unchanged.
 */
export function truncateToolBodies(messages: Message[]): LoggedMessage[] {
	return messages.map((m) => {
		if (m.role !== "toolResult") return m;
		const tr = m as ToolResultMessage;
		const truncatedContent = tr.content.map((block) => {
			if (block.type !== "text") return block;
			const text = block.text;
			if (text.length <= MAX_TOOL_BODY_CHARS) return block;
			return {
				...block,
				text: `${text.slice(0, MAX_TOOL_BODY_CHARS)}… [truncated ${text.length - MAX_TOOL_BODY_CHARS} chars]`,
			};
		});
		return { ...tr, content: truncatedContent };
	});
}

// ---------------------------------------------------------------------------
// MongoDB implementation
// ---------------------------------------------------------------------------

export function createMongoLlmCallLogRepository(db: Db): LlmCallLogRepository {
	const col = db.collection<LlmCallLogEntry & { _id?: unknown }>("llmCallLog");

	// Index for time-range queries (the primary access pattern for dashboards
	// and billing reconciliation).
	col
		.createIndex({ savedAt: 1 })
		.catch((e: unknown) =>
			console.warn("[llm-call-log] Failed to create savedAt index:", (e as Error).message),
		);

	// Index for per-agent/per-mission queries.
	col
		.createIndex({ missionId: 1, agentId: 1, savedAt: 1 })
		.catch((e: unknown) =>
			console.warn("[llm-call-log] Failed to create mission index:", (e as Error).message),
		);

	return {
		async append(entry) {
			await col.insertOne({ ...entry });
		},

		async query(filter) {
			const q: Record<string, unknown> = {};
			if (filter.missionId !== undefined) q.missionId = filter.missionId;
			if (filter.agentId !== undefined) q.agentId = filter.agentId;
			if (filter.isReflection !== undefined) q.isReflection = filter.isReflection;
			if (filter.from !== undefined || filter.to !== undefined) {
				const range: Record<string, Date> = {};
				if (filter.from) range.$gte = filter.from;
				if (filter.to) range.$lte = filter.to;
				q.savedAt = range;
			}
			const docs = await col.find(q).sort({ savedAt: 1 }).toArray();
			return docs.map(({ _id: _discarded, ...rest }) => rest as LlmCallLogEntry);
		},
	};
}
