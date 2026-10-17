/**
 * TX1: every LLM call gets one id, handed to both the audit hook and the
 * message hook, so a log entry and the assistant message it produced can be
 * joined exactly instead of by position.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { type CompleteFn, runInnerLoop } from "../src/loop.js";
import { CLAUDE_SONNET } from "../src/models.js";

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("runInnerLoop call ids", () => {
	it("gives onLlmCall and the assistant message's onMessage the same fresh id, and no id to other messages", async () => {
		const completeFn: CompleteFn = async () => reply("done");
		const llmCallIds: string[] = [];
		const messageMeta: Array<{ role: string; callId?: string }> = [];
		await runInnerLoop({
			model: CLAUDE_SONNET,
			getSystemPrompt: () => "s",
			task: "t",
			tools: [],
			completeFn,
			onLlmCall: async (e) => {
				llmCallIds.push(e.callId);
			},
			onMessage: async (msg, _all, meta) => {
				messageMeta.push({ role: msg.role, callId: meta?.callId });
			},
		});
		expect(llmCallIds).toHaveLength(1);
		expect(llmCallIds[0]).toMatch(/^[0-9a-f-]{36}$/);
		expect(messageMeta).toEqual([
			{ role: "user", callId: undefined },
			{ role: "assistant", callId: llmCallIds[0] },
		]);
	});
});
