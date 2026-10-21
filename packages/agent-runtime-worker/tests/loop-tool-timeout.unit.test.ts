/**
 * T3: a tool that outlives its timeout must be cancelled, not just stopped
 * waiting for — and a tool that declares a longer budget gets it.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { type CompleteFn, runInnerLoop } from "../src/loop.js";
import { CLAUDE_SONNET } from "../src/models.js";
import type { MagiTool } from "../src/tools.js";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const base = {
	role: "assistant" as const,
	api: "anthropic-messages" as const,
	provider: "anthropic",
	model: "m",
	usage,
	timestamp: Date.now(),
};

/** One call to the tool, then a plain answer. */
function oneToolCall(): CompleteFn {
	let n = 0;
	return async (): Promise<AssistantMessage> =>
		n++ === 0
			? {
					...base,
					content: [
						{ type: "toolCall", id: "c1", name: "Slow", arguments: {} },
					],
					stopReason: "toolUse",
				}
			: {
					...base,
					content: [{ type: "text", text: "done" }],
					stopReason: "stop",
				};
}

/** Resolves after `ms`, or rejects as soon as its signal aborts. */
function slowTool(
	ms: number,
	seen: { aborted: boolean },
	maxRuntimeMs?: number,
): MagiTool {
	return {
		name: "Slow",
		description: "",
		parameters: Type.Object({}),
		...(maxRuntimeMs ? { maxRuntimeMs: () => maxRuntimeMs } : {}),
		execute: (_id, _args, signal) =>
			new Promise((resolve, reject) => {
				const t = setTimeout(
					() => resolve({ content: [{ type: "text", text: "finished" }] }),
					ms,
				);
				signal?.addEventListener("abort", () => {
					seen.aborted = true;
					clearTimeout(t);
					reject(new Error("cancelled"));
				});
			}),
	};
}

const resultText = (messages: { role: string; content?: unknown }[]) => {
	const r = messages.find((m) => m.role === "toolResult") as {
		content: { text: string }[];
		isError?: boolean;
	};
	return { text: r.content[0].text, isError: r.isError };
};

describe("tool timeouts (T3)", () => {
	it("aborts the tool's signal when it times out, and reports the timeout", async () => {
		const seen = { aborted: false };
		const { messages } = await runInnerLoop({
			model: CLAUDE_SONNET,
			getSystemPrompt: () => "s",
			task: "t",
			tools: [slowTool(5_000, seen)],
			completeFn: oneToolCall(),
			toolTimeoutMs: 30,
		});
		expect(seen.aborted).toBe(true);
		expect(resultText(messages)).toEqual({
			text: 'Tool "Slow" timed out after 30ms',
			isError: true,
		});
	});

	it("waits for a tool's declared longer budget instead of the default", async () => {
		const seen = { aborted: false };
		const { messages } = await runInnerLoop({
			model: CLAUDE_SONNET,
			getSystemPrompt: () => "s",
			task: "t",
			tools: [slowTool(60, seen, 1_000)],
			completeFn: oneToolCall(),
			toolTimeoutMs: 20,
		});
		expect(seen.aborted).toBe(false);
		expect(resultText(messages).text).toBe("finished");
	});
});
