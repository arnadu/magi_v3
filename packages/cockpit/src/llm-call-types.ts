/**
 * The Transcripts tab's view of one LLM call and one transcript message:
 * the shared API shapes (agent-config/src/api/transcripts.ts) as they arrive
 * over JSON — dates as ISO strings, messages as the cockpit's RawMessage.
 * Type-only import: nothing from agent-config is bundled.
 */

import type {
	LlmCallDetail as ApiLlmCallDetail,
	LlmCallSummary as ApiLlmCallSummary,
	TranscriptEntry as ApiTranscriptEntry,
	CallUsage,
} from "@magi/agent-config";
import type { RawMessage } from "./data.js";

export type Usage = CallUsage;
export type LlmCallSummary = ApiLlmCallSummary<string>;
export type LlmCallDetail = ApiLlmCallDetail<string, RawMessage>;
export type TranscriptEntry = ApiTranscriptEntry<RawMessage>;
