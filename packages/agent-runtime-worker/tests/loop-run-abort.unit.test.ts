/**
 * Issue #65: a run whose AbortSignal fires must end, even when the provider
 * ignores the signal and keeps answering — otherwise every later tool call
 * fails with "canceled" and the turn runs on as a zombie.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { type CompleteFn, runInnerLoop } from "../src/loop.js";
import { CLAUDE_SONNET } from "../src/models.js";
import type { MagiTool } from "../src/tools.js";

function toolCallMessage(n: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `c${n}`, name: "Bash", arguments: {} }],
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
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("runInnerLoop stops once the run signal is aborted", () => {
	it("does not call the model again after an abort, even though the model would keep answering", async () => {
		const ac = new AbortController();
		let llmCalls = 0;
		let toolRuns = 0;
		const completeFn: CompleteFn = async () => toolCallMessage(++llmCalls);
		const bash: MagiTool = {
			name: "Bash",
			description: "",
			parameters: Type.Object({}),
			execute: async () => {
				toolRuns++;
				ac.abort(); // the wall-clock limit fires while the tool runs
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const { messages } = await runInnerLoop({
			model: CLAUDE_SONNET,
			getSystemPrompt: () => "s",
			task: "t",
			tools: [bash],
			completeFn,
			signal: ac.signal,
		});
		expect(llmCalls).toBe(1);
		expect(toolRuns).toBe(1);
		expect(messages.at(-1)?.role).toBe("toolResult");
	});

	it("records an abort error for tools that had not started when the signal fired", async () => {
		const ac = new AbortController();
		const completeFn: CompleteFn = async () => ({
			...toolCallMessage(1),
			content: [
				{ type: "toolCall", id: "a", name: "Bash", arguments: {} },
				{ type: "toolCall", id: "b", name: "Bash", arguments: {} },
			],
		});
		let runs = 0;
		const bash: MagiTool = {
			name: "Bash",
			description: "",
			parameters: Type.Object({}),
			execute: async () => {
				runs++;
				ac.abort();
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const { messages } = await runInnerLoop({
			model: CLAUDE_SONNET,
			getSystemPrompt: () => "s",
			task: "t",
			tools: [bash],
			completeFn,
			signal: ac.signal,
		});
		expect(runs).toBe(1);
		const results = messages.filter((m) => m.role === "toolResult");
		expect(results).toHaveLength(2);
		expect(JSON.stringify(results[1])).toMatch(/Run aborted/);
	});
});
