/**
 * Regression test for the copilot model-switch incident: a stream cut short
 * by an abort (or a mid-stream provider error) can still carry parsed
 * toolCall blocks pi-ai never got to execute. runInnerLoop must not persist
 * that as a dangling tool_use — every future replay against ANY provider
 * fails identically once that happens, since tool_use/tool_result pairing is
 * a structural requirement, not something specific to one provider's API.
 */

import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { type CompleteFn, runInnerLoop } from "../src/loop.js";
import { CLAUDE_SONNET } from "../src/models.js";

function assistantAbortedWithToolCall(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "toolu_stuck",
				name: "ProposeAction",
				arguments: {},
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "aborted",
		timestamp: Date.now(),
	};
}

function assistantErrorWithToolCall(): AssistantMessage {
	return {
		...assistantAbortedWithToolCall(),
		stopReason: "error",
		errorMessage: "500",
	};
}

describe("runInnerLoop — abort/error with an in-flight tool call", () => {
	it("persists a synthetic error tool result for a dangling tool_use on abort, so the loop's own output is never structurally invalid", async () => {
		const completeFn: CompleteFn = async () => assistantAbortedWithToolCall();
		const persisted: Message[] = [];
		const result = await runInnerLoop({
			model: CLAUDE_SONNET,
			getSystemPrompt: () => "system",
			task: "do something",
			tools: [],
			completeFn,
			onMessage: async (msg) => {
				persisted.push(msg);
			},
		});

		// The assistant message itself, plus a synthetic toolResult for its
		// dangling tool_use — never just the bare assistant message alone.
		const toolResults = persisted.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toMatchObject({
			role: "toolResult",
			toolCallId: "toolu_stuck",
			toolName: "ProposeAction",
			isError: true,
		});

		// The persisted sequence is immediately replay-safe: every toolCall has
		// a matching toolResult right in this same session's output, not
		// dependent on a later read-time patch (convertToLlm) to paper over it.
		const lastAssistantIdx = persisted.findIndex((m) => m.role === "assistant");
		expect(persisted[lastAssistantIdx + 1]?.role).toBe("toolResult");

		expect(result.messages.filter((m) => m.role === "toolResult")).toHaveLength(
			1,
		);
	});

	it("does the same for a mid-stream provider error, not just an explicit abort", async () => {
		const completeFn: CompleteFn = async () => assistantErrorWithToolCall();
		const persisted: Message[] = [];
		await runInnerLoop({
			model: CLAUDE_SONNET,
			getSystemPrompt: () => "system",
			task: "do something",
			tools: [],
			completeFn,
			onMessage: async (msg) => {
				persisted.push(msg);
			},
		});
		expect(persisted.filter((m) => m.role === "toolResult")).toHaveLength(1);
	});

	it("does nothing extra when the aborted message has no tool calls", async () => {
		const completeFn: CompleteFn = async () => ({
			...assistantAbortedWithToolCall(),
			content: [],
		});
		const persisted: Message[] = [];
		await runInnerLoop({
			model: CLAUDE_SONNET,
			getSystemPrompt: () => "system",
			task: "do something",
			tools: [],
			completeFn,
			onMessage: async (msg) => {
				persisted.push(msg);
			},
		});
		expect(persisted.filter((m) => m.role === "toolResult")).toHaveLength(0);
	});
});
