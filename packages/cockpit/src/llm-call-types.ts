/**
 * The Transcripts tab's view of one LLM call and one transcript message —
 * the shapes `control-plane/src/transcript-queries.ts` serves (`CallUsage`,
 * `LlmCallSummary`, `LlmCallDetail`, `TranscriptEntry`). Keep the two in step.
 */

import type { RawMessage } from "./data.js";

export interface TranscriptEntry {
	callSeq: number;
	/** Joins an assistant message to `LlmCallSummary.callId`; null for data written before the id existed. */
	callId: string | null;
	parentToolUseId: string | null;
	message: RawMessage;
}

/** Mirrors `CallUsage` in control-plane/src/transcript-queries.ts — the server flattens the stored entry to this. */
export interface Usage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

export interface LlmCallSummary {
	index: number;
	callId: string | null;
	savedAt: string;
	model: string;
	isReflection: boolean;
	costEstimated: boolean;
	stopReason: string | null;
	usage: Usage | null;
	costUsd: number | null;
	toolNames: string[];
	messageCount: number;
	hasBody: boolean;
}

export interface LlmCallDetail {
	index: number;
	callId: string | null;
	savedAt: string;
	model: string;
	isReflection: boolean;
	costEstimated: boolean;
	usage: Usage | null;
	costUsd: number | null;
	input: {
		systemPrompt: string;
		messages: RawMessage[];
		toolNames: string[];
	} | null;
	/** As stored by the writer: the model's message plus its stop reason. */
	output: { message: RawMessage; stopReason: string } | null;
}
