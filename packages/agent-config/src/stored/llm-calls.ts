/**
 * `llmCallLog`: one entry per LLM call (agent turns, reflection, tool-side
 * vision/OCR calls), written by the worker's llm-call-log repository. Read by
 * the cockpit transcript routes, copilot usage/spend checks and the
 * retention pruner. `input`/`output` are removed after a day, the entry after
 * 90 days.
 */

import type { AssistantMessage, Message } from "@mariozechner/pi-ai";

/** A message as stored in the log — tool result bodies may be truncated. */
export type LoggedMessage = Message;

export interface LlmCallCost {
	/**
	 * Per-component breakdown, always computed from the static price table —
	 * even when `totalCostUsd` is provider-reported (OpenRouter's `usage.cost`
	 * doesn't split by component, so these four may not sum to `totalCostUsd`
	 * in that case; see `costEstimated` on `LlmCallLogEntry`).
	 */
	inputCostUsd: number;
	outputCostUsd: number;
	cacheReadCostUsd: number;
	cacheWriteCostUsd: number;
	/**
	 * The effective cost used everywhere downstream (llmCallLog, agentTurnStats,
	 * missionStats, budget/limit checks). Exact when the provider reports its own
	 * charged amount (OpenRouter's `usage.cost` — see issue #10); a static-price
	 * estimate otherwise.
	 */
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
 *
 * The control-plane pruner (scheduler.ts) removes `input`/`output` after
 * LOG_BODY_RETENTION_DAYS (1) and deletes the entry after
 * LOG_ROW_RETENTION_DAYS (90); `usage` and the metadata fields are present on
 * every entry that remains.
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
	/**
	 * Joins this entry to the `conversationMessages` assistant message it
	 * produced (both carry the id runInnerLoop generated). Absent on tool-side
	 * calls (vision, OCR), which have no transcript message, and on entries
	 * written before the field existed.
	 */
	callId?: string;
	/**
	 * True when `usage.cost.totalCostUsd` is a static-price-table estimate
	 * rather than an authoritative figure. False for first-party Anthropic
	 * (exact list prices) and for OpenRouter calls where the provider reported
	 * its own charged amount (`usage.cost` on the response — see GitHub issue
	 * #10); true for OpenRouter calls where it didn't, and for any other
	 * non-Anthropic provider. Absent on entries written before this field
	 * existed (treat as unknown).
	 */
	costEstimated?: boolean;
	/** Full call input — absent once the pruner's retention window has passed. */
	input?: {
		systemPrompt: string;
		/** Full message context sent to the model (tool bodies truncated). */
		messages: LoggedMessage[];
		/** Names of tools made available on this call. */
		toolNames: string[];
	};
	/** Full model response — absent once the pruner's retention window has passed. */
	output?: {
		/** Full AssistantMessage returned by the model. */
		message: AssistantMessage;
		stopReason: string;
	};
	usage: LlmCallUsage;
}
