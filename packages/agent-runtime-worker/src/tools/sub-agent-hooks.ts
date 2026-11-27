/**
 * What every sub-agent (Investigate, Research) must be given by whoever builds
 * it — an agent's turn or the Tool API for a background job. Required, not
 * optional: a sub-agent built without them ran unrecorded and uncharged
 * (llm-call.recorded, llm-call.cost-counted, turn.persisted-per-step).
 */

import type { Message } from "@mariozechner/pi-ai";
import type { LlmCallEvent, LlmCallMeter } from "../llm-meter.js";

export interface SubAgentHooks {
	/** Stores each step (the task, each answer, each tool result) before the next starts. */
	onMessage: (toolUseId: string, msg: Message) => Promise<void>;
	/** Logs each model call and charges it to the calling agent. */
	onLlmCall: LlmCallMeter;
	/** Awaited before each model call: the mission's spend-cap pause. */
	beforeLlmCall: () => Promise<void>;
	/** What a call cost, priced as `onLlmCall` records it: a sub-agent keeps its own spend with it. */
	costOf: (event: LlmCallEvent) => number;
}
