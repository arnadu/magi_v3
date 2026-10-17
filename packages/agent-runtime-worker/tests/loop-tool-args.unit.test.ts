/**
 * LP2: runInnerLoop validates every tool call against the tool's schema
 * before execute runs. A schema failure is an ordinary isError tool result the
 * model sees on its next call — the tool itself never runs on bad arguments.
 */

import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
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

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

describe("runInnerLoop tool-argument validation (LP2)", () => {
	it("refuses a call that violates the schema with an isError result and runs the corrected call", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const writeTool: MagiTool = {
			name: "WriteFile",
			description: "writes",
			parameters: Type.Object({
				path: Type.String(),
				content: Type.String(),
			}),
			execute: async (_id, args) => {
				executed.push(args);
				return { content: [{ type: "text", text: "written" }] };
			},
		};

		let call = 0;
		const completeFn: CompleteFn = async () => {
			call++;
			if (call === 1) {
				return assistant(
					[
						{
							type: "toolCall",
							id: "bad",
							name: "WriteFile",
							arguments: { path: "a.txt" }, // content missing
						},
					],
					"toolUse",
				);
			}
			if (call === 2) {
				return assistant(
					[
						{
							type: "toolCall",
							id: "good",
							name: "WriteFile",
							arguments: { path: "a.txt", content: "hello" },
						},
					],
					"toolUse",
				);
			}
			return assistant([{ type: "text", text: "done" }], "stop");
		};

		const results: Array<{ toolName: string; isError: boolean }> = [];
		const { messages } = await runInnerLoop({
			model: CLAUDE_SONNET,
			getSystemPrompt: () => "system",
			task: "write the file",
			tools: [writeTool],
			completeFn,
			onToolResult: async (r) => {
				results.push({ toolName: r.toolName, isError: r.isError });
			},
		});

		// The tool ran exactly once, on the valid call only.
		expect(executed).toEqual([{ path: "a.txt", content: "hello" }]);
		expect(results).toEqual([
			{ toolName: "WriteFile", isError: true },
			{ toolName: "WriteFile", isError: false },
		]);

		// The rejection is in the transcript as a normal tool result the model saw.
		const toolResults = messages.filter(
			(m: Message) => m.role === "toolResult",
		);
		expect(toolResults).toHaveLength(2);
		const first = toolResults[0] as Extract<Message, { role: "toolResult" }>;
		expect(first.toolCallId).toBe("bad");
		expect(first.isError).toBe(true);
		expect(first.content[0]).toMatchObject({ type: "text" });
		expect((first.content[0] as { type: "text"; text: string }).text).toContain(
			"Validation failed",
		);
	});
});
