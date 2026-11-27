/** Sub-agent hooks for tests: every stored step and every metered call, kept for assertions. */
import type { Message } from "@mariozechner/pi-ai";
import type { LlmCallEvent } from "../src/llm-meter.js";
import type { SubAgentHooks } from "../src/tools/sub-agent-hooks.js";

export function recordingHooks(): {
	hooks: SubAgentHooks;
	steps: { toolUseId: string; msg: Message }[];
	calls: LlmCallEvent[];
} {
	const steps: { toolUseId: string; msg: Message }[] = [];
	const calls: LlmCallEvent[] = [];
	return {
		hooks: {
			onMessage: async (toolUseId, msg) => void steps.push({ toolUseId, msg }),
			onLlmCall: async (event) => void calls.push(event),
			beforeLlmCall: async () => {},
		},
		steps,
		calls,
	};
}
