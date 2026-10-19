/**
 * What the control plane's transcript routes serve and the cockpit reads
 * (`control-plane/src/transcript-queries.ts` builds these). One definition
 * for both sides of the JSON boundary: `D` is the date type (`Date` on the
 * server, `string` once serialised) and `M` the message type (pi-ai's
 * `Message` on the server, the cockpit's own looser shape in the browser).
 */

/** Token counts as the UI shows them, flattened from the stored `usage`. */
export interface CallUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

export interface LlmCallSummary<D = string> {
	index: number;
	/** Joins the call to its assistant message's `TranscriptEntry.callId`. */
	callId: string | null;
	savedAt: D;
	model: string;
	isReflection: boolean;
	costEstimated: boolean;
	stopReason: string | null;
	usage: CallUsage | null;
	costUsd: number | null;
	toolNames: string[];
	messageCount: number;
	hasBody: boolean;
}

export interface LlmCallDetail<D = string, M = unknown> {
	index: number;
	callId: string | null;
	savedAt: D;
	model: string;
	isReflection: boolean;
	costEstimated: boolean;
	usage: CallUsage | null;
	costUsd: number | null;
	/** What the model was sent; null once the call body is gone. */
	input: { systemPrompt: string; messages: M[]; toolNames: string[] } | null;
	/** The model's message and its stop reason; null once the call body is gone. */
	output: { message: M; stopReason: string } | null;
}

export interface TranscriptEntry<M = unknown> {
	callSeq: number;
	/** Joins an assistant message to `LlmCallSummary.callId`; null for data written before the id existed. */
	callId: string | null;
	parentToolUseId: string | null;
	message: M;
}
