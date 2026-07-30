/**
 * OpenRouter caching investigation (issue #24): runInnerLoop injects the
 * "dynamic context" message (current time + mental map) at messages[0] and
 * only REPLACES it in place when the content actually changes, rather than
 * pushing a new one each iteration. This is what lets the system prompt (and
 * everything after messages[0]) stay byte-identical across iterations where
 * nothing changed — the actual cache/routing-stability mechanism. This test
 * covers the pure, deterministic core of that behavior directly, without a
 * real LLM call.
 */

import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { type CompleteFn, runInnerLoop } from "../src/loop.js";
import { CLAUDE_SONNET } from "../src/models.js";
import type { MagiTool } from "../src/tools.js";

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function assistantToolCall(name: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name, arguments: {} }],
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
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("runInnerLoop dynamic-context injection", () => {
	it("replaces messages[0] in place when unchanged between calls, growing everything after it — never a second copy", async () => {
		let dynamicContext = "v1";
		const bumpTool: MagiTool = {
			name: "bump",
			description: "bumps the dynamic context",
			parameters: Type.Object({}),
			execute: async () => {
				dynamicContext = "v2";
				return { content: [{ type: "text", text: "bumped" }] };
			},
		};

		let callCount = 0;
		const completeFn: CompleteFn = async () => {
			callCount++;
			return callCount === 1
				? assistantToolCall("bump")
				: assistantText("done");
		};

		const snapshots: Message[][] = [];
		await runInnerLoop({
			model: CLAUDE_SONNET,
			getSystemPrompt: () => "system",
			getDynamicContext: () => dynamicContext,
			task: "do something",
			tools: [bumpTool],
			completeFn,
			onLlmCall: async (event) => {
				snapshots.push(event.messages);
			},
		});

		expect(snapshots).toHaveLength(2);

		// Call 1: [dynamicContext(v1), task] — unchanged since injection, so still v1.
		expect(snapshots[0]).toHaveLength(2);
		expect(snapshots[0][0]).toMatchObject({ role: "user", content: "v1" });
		expect(snapshots[0][1]).toMatchObject({
			role: "user",
			content: "do something",
		});

		// Call 2: dynamicContext changed to v2 mid-turn (the tool call) — messages[0]
		// is REPLACED (still exactly one leading dynamic-context message, not two),
		// and everything from call 1 is still present after it, untouched.
		expect(snapshots[1][0]).toMatchObject({ role: "user", content: "v2" });
		expect(
			snapshots[1].filter((m) => m.role === "user" && m.content === "v1"),
		).toHaveLength(0);
		expect(
			snapshots[1].filter(
				(m) => m.role === "user" && (m.content === "v1" || m.content === "v2"),
			),
		).toHaveLength(1);
	});

	it("without getDynamicContext, behaves exactly as before — no leading message injected", async () => {
		const completeFn: CompleteFn = async () => assistantText("done");
		const snapshots: Message[][] = [];
		await runInnerLoop({
			model: CLAUDE_SONNET,
			getSystemPrompt: () => "system",
			task: "do something",
			tools: [],
			completeFn,
			onLlmCall: async (event) => {
				snapshots.push(event.messages);
			},
		});
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]).toHaveLength(1);
		expect(snapshots[0][0]).toMatchObject({
			role: "user",
			content: "do something",
		});
	});
});
