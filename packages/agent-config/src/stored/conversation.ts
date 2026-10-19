/**
 * `conversationMessages`: every agent's conversation history, one document
 * per message, written by the worker's ConversationRepository. Compacted and
 * reflection documents stay in the collection but are excluded from prompts.
 */

import type { Message } from "@mariozechner/pi-ai";

/** A MAGI-internal message that replaces compacted history. */
export interface SummaryMessage {
	role: "summary";
	content: string;
}

export interface ConversationDoc {
	agentId: string;
	missionId: string;
	turnNumber: number;
	seqInTurn: number;
	message: Message | SummaryMessage;
	savedAt: Date;
	/**
	 * Set to true by compact() when reflection has summarised this turn.
	 * Compacted documents are excluded from load() (prompt preparation) but
	 * retained in MongoDB for auditability and future RAG-based retrieval.
	 */
	compacted?: boolean;
	/**
	 * Set to true for messages produced by the reflection inner loop.
	 * Excluded from load() so they never appear in the agent's prompt context,
	 * but retained in MongoDB for debugging and future UI display.
	 */
	isReflection?: boolean;
	/** Which LLM call (0-based) within the session this message belongs to. */
	callSeq?: number;
	callId?: string;
	/** Mental map HTML snapshot at the time of this LLM call (AssistantMessages only). */
	mentalMapHtml?: string;
	/** Parent tool_use block id for sub-loop messages. */
	parentToolUseId?: string;
}
