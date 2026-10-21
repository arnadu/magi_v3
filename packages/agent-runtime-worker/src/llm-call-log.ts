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
 *   - `input.messages` is capped to the most recent MAX_LOGGED_MESSAGES — without
 *     this, `messages` is the *entire accumulated conversation at call time*, so a
 *     deep mission re-stores its whole early history on every single subsequent
 *     call (O(n²) growth). Older messages are still fully recoverable from
 *     `conversationMessages`; they were also captured in full themselves, at the
 *     point they were newest, in some earlier logged call.
 *   - Retention policy (`scheduler.ts`): `input` and `output` are removed
 *     after LOG_BODY_RETENTION_DAYS (1); the entry, with missionId, agentId,
 *     turnNumber, model, savedAt, isReflection and usage, is deleted after
 *     LOG_ROW_RETENTION_DAYS (90).
 *
 * Collection: `llmCallLog`
 */

import type {
	LlmCallCost,
	LlmCallLogEntry,
	LlmCallUsage,
	LoggedMessage,
} from "@magi/agent-config";
import { storedCollection } from "@magi/agent-config";
import type { Message, ToolResultMessage } from "@mariozechner/pi-ai";
import type { Db } from "mongodb";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tool result bodies beyond this length are truncated in the stored log. */
const MAX_TOOL_BODY_CHARS = 2_000;

/**
 * Only the most recent MAX_LOGGED_MESSAGES are kept in full per logged call —
 * see the module header comment for why. Chosen to comfortably cover a single
 * turn's worth of tool-call back-and-forth for the cockpit's Transcripts "Input"
 * drill-down, without re-storing an entire mission's history on every call.
 */
const MAX_LOGGED_MESSAGES = 40;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { LlmCallCost, LlmCallLogEntry, LlmCallUsage, LoggedMessage };

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
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	},
	modelCost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	},
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
		totalCostUsd:
			inputCostUsd + outputCostUsd + cacheReadCostUsd + cacheWriteCostUsd,
	};
}

/**
 * Resolve the effective cost + costEstimated flag for one call, preferring
 * the provider-reported cost (OpenRouter's `usage.cost`, surfaced by pi-ai as
 * `AssistantMessage.usage.providerCost` — see issue #10) over the
 * static-price-table estimate for `totalCostUsd`. The itemized per-component
 * breakdown is always the static estimate — OpenRouter reports one total
 * figure, not a per-component split.
 */
export function resolveCallCost(
	estimatedCost: LlmCallCost,
	provider: string,
	providerCost: number | undefined,
): { cost: LlmCallCost; costEstimated: boolean } {
	const costIsExact = provider === "anthropic" || providerCost !== undefined;
	return {
		cost:
			providerCost !== undefined
				? { ...estimatedCost, totalCostUsd: providerCost }
				: estimatedCost,
		costEstimated: !costIsExact,
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

/**
 * Return a copy of the message array with only the most recent
 * MAX_LOGGED_MESSAGES kept; earlier ones are replaced with a single count
 * marker. Combined with truncateToolBodies, this bounds each logged call's
 * storage footprint to roughly constant size regardless of how deep into a
 * mission the call happens — without it, a long-running mission's llmCallLog
 * entries grow with the conversation on every single call, not just once.
 */
export function truncateOldMessages(messages: Message[]): LoggedMessage[] {
	if (messages.length <= MAX_LOGGED_MESSAGES) return messages;
	const omitted = messages.length - MAX_LOGGED_MESSAGES;
	const marker: Message = {
		role: "user",
		content: `[${omitted} earlier message(s) omitted from this log entry — see conversationMessages for full mission history]`,
		timestamp: Date.now(),
	};
	return [marker, ...messages.slice(-MAX_LOGGED_MESSAGES)];
}

// ---------------------------------------------------------------------------
// MongoDB implementation
// ---------------------------------------------------------------------------

export function createMongoLlmCallLogRepository(db: Db): LlmCallLogRepository {
	const col = storedCollection(db, "llmCallLog");

	// Index for time-range queries (the primary access pattern for dashboards
	// and billing reconciliation).
	col
		.createIndex({ savedAt: 1 })
		.catch((e: unknown) =>
			console.warn(
				"[llm-call-log] Failed to create savedAt index:",
				(e as Error).message,
			),
		);

	// Index for per-agent/per-mission queries sorted by turn then time.
	// turnNumber must be in the index so the sort in /agents/:id/sessions and
	// /agents/:id/usage is index-backed; without it MongoDB does an in-memory
	// sort that exceeds the 32 MB limit on large missions.
	col
		.createIndex({ missionId: 1, agentId: 1, turnNumber: 1, savedAt: 1 })
		.catch((e: unknown) =>
			console.warn(
				"[llm-call-log] Failed to create mission index:",
				(e as Error).message,
			),
		);

	return {
		async append(entry) {
			await col.insertOne({ ...entry });
		},

		async query(filter) {
			const q: Record<string, unknown> = {};
			if (filter.missionId !== undefined) q.missionId = filter.missionId;
			if (filter.agentId !== undefined) q.agentId = filter.agentId;
			if (filter.isReflection !== undefined)
				q.isReflection = filter.isReflection;
			if (filter.from !== undefined || filter.to !== undefined) {
				const range: Record<string, Date> = {};
				if (filter.from) range.$gte = filter.from;
				if (filter.to) range.$lte = filter.to;
				q.savedAt = range;
			}
			const docs = await col.find(q).sort({ savedAt: 1 }).toArray();
			return docs.map(
				({ _id: _discarded, ...rest }) => rest as LlmCallLogEntry,
			);
		},
	};
}
