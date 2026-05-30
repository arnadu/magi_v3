import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
	EPHEMERAL_TOOLS,
	PRUNED_STUB,
	pruneEphemeralResults,
} from "../src/context-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMsg(text: string): Message {
	return { role: "user", content: text, timestamp: 0 };
}

function assistantMsg(
	text: string,
	toolCalls: string[] = [],
	thinking?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [
			...(thinking
				? [{ type: "thinking" as const, thinking, thinkingSignature: "sig" }]
				: []),
			{ type: "text" as const, text },
			...toolCalls.map((name) => ({
				type: "toolCall" as const,
				id: `tc-${name}`,
				name,
				arguments: {},
			})),
		],
		stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
		timestamp: 0,
	};
}

function toolResult(
	toolName: string,
	text: string,
	id?: string,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id ?? `tc-${toolName}`,
		toolName,
		content: [{ type: "text", text }],
		timestamp: 0,
	};
}

function buildConversation(
	rounds: Array<{
		tools: Array<{ name: string; result: string }>;
		thinking?: string;
	}>,
): Message[] {
	const msgs: Message[] = [userMsg("task")];
	for (const round of rounds) {
		msgs.push(
			assistantMsg(
				"thinking…",
				round.tools.map((t) => t.name),
				round.thinking,
			),
		);
		for (const t of round.tools) {
			msgs.push(toolResult(t.name, t.result));
		}
	}
	// Final assistant message with no tool calls
	msgs.push(assistantMsg("done"));
	return msgs;
}

function getToolResultText(msgs: Message[], toolName: string): string[] {
	return msgs
		.filter(
			(m): m is ToolResultMessage =>
				m.role === "toolResult" &&
				(m as ToolResultMessage).toolName === toolName,
		)
		.map((m) => (m.content[0].type === "text" ? m.content[0].text : ""));
}

function getThinkingBlocks(
	msgs: Message[],
): Array<{ text: string; idx: number }> {
	const out: Array<{ text: string; idx: number }> = [];
	msgs.forEach((m, idx) => {
		if (m.role === "assistant") {
			const am = m as AssistantMessage;
			for (const b of am.content) {
				if (b.type === "thinking") {
					out.push({ text: b.thinking, idx });
				}
			}
		}
	});
	return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EPHEMERAL_TOOLS", () => {
	it("contains expected tool names", () => {
		expect(EPHEMERAL_TOOLS.has("Bash")).toBe(true);
		expect(EPHEMERAL_TOOLS.has("SearchWeb")).toBe(true);
		expect(EPHEMERAL_TOOLS.has("FetchUrl")).toBe(true);
		expect(EPHEMERAL_TOOLS.has("BrowseWeb")).toBe(true);
		expect(EPHEMERAL_TOOLS.has("ReadFile")).toBe(true);
		expect(EPHEMERAL_TOOLS.has("InspectImage")).toBe(true);
		// Durable tools must NOT be in the set
		expect(EPHEMERAL_TOOLS.has("WriteFile")).toBe(false);
		expect(EPHEMERAL_TOOLS.has("EditFile")).toBe(false);
		expect(EPHEMERAL_TOOLS.has("PostMessage")).toBe(false);
	});
});

describe("pruneEphemeralResults", () => {
	it("returns a copy; input is not mutated", () => {
		const msgs = buildConversation([
			{ tools: [{ name: "Bash", result: "output" }] },
			{ tools: [{ name: "Bash", result: "output2" }] },
			{ tools: [{ name: "Bash", result: "output3" }] },
		]);
		const original = JSON.stringify(msgs);
		pruneEphemeralResults(msgs, 2);
		expect(JSON.stringify(msgs)).toBe(original);
	});

	it("stubs ephemeral results from old rounds; keeps last keepLastRounds", () => {
		// Build 4 tool-calling rounds without a trailing "done" so assistant
		// message count equals round count and keepLastRounds=2 keeps rounds 3+4.
		const msgs: Message[] = [
			userMsg("task"),
			assistantMsg("s1", ["Bash"]),
			toolResult("Bash", "round1"),
			assistantMsg("s2", ["Bash"]),
			toolResult("Bash", "round2"),
			assistantMsg("s3", ["Bash"]),
			toolResult("Bash", "round3"),
			assistantMsg("s4", ["Bash"]),
			toolResult("Bash", "round4"),
		];

		const pruned = pruneEphemeralResults(msgs, 2);
		const texts = getToolResultText(pruned, "Bash");

		// rounds 1 and 2 are pruned; rounds 3 and 4 are kept
		expect(texts[0]).toBe(PRUNED_STUB);
		expect(texts[1]).toBe(PRUNED_STUB);
		expect(texts[2]).toBe("round3");
		expect(texts[3]).toBe("round4");
	});

	it("never stubs durable tool results", () => {
		const msgs = buildConversation([
			{ tools: [{ name: "WriteFile", result: "written" }] },
			{ tools: [{ name: "WriteFile", result: "written2" }] },
			{ tools: [{ name: "WriteFile", result: "written3" }] },
		]);

		const pruned = pruneEphemeralResults(msgs, 2);
		const texts = getToolResultText(pruned, "WriteFile");

		// All WriteFile results are preserved regardless of round
		expect(texts[0]).toBe("written");
		expect(texts[1]).toBe("written2");
		expect(texts[2]).toBe("written3");
	});

	it("is idempotent — already-stubbed results are not modified", () => {
		const msgs = buildConversation([
			{ tools: [{ name: "Bash", result: "big output" }] },
			{ tools: [{ name: "Bash", result: "round2" }] },
			{ tools: [{ name: "Bash", result: "round3" }] },
		]);

		const once = pruneEphemeralResults(msgs, 2);
		const twice = pruneEphemeralResults(once, 2);
		expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
	});

	it("strips thinking blocks from all but the last assistant message", () => {
		// Build manually without a trailing "done" so the last assistant message
		// IS the final tool-calling round (thinking should be kept).
		const msgs: Message[] = [
			userMsg("task"),
			assistantMsg("step1", ["Bash"], "thought1"),
			toolResult("Bash", "r1"),
			assistantMsg("step2", ["Bash"], "thought2"),
			toolResult("Bash", "r2"),
			assistantMsg("step3", ["Bash"], "thought3"),
			toolResult("Bash", "r3"),
		];

		const pruned = pruneEphemeralResults(msgs, 2);
		const thinking = getThinkingBlocks(pruned);

		// Only the most recent thinking block (round 3) is kept.
		expect(thinking).toHaveLength(1);
		expect(thinking[0].text).toBe("thought3");
	});

	it("strips all thinking blocks when the last message is a final text response", () => {
		// In a completed conversation the last assistant msg has no tool calls.
		// All thinking blocks from earlier tool-calling rounds are stripped.
		const msgs = buildConversation([
			{ tools: [{ name: "Bash", result: "r1" }], thinking: "thought1" },
			{ tools: [{ name: "Bash", result: "r2" }], thinking: "thought2" },
		]);

		const pruned = pruneEphemeralResults(msgs, 2);
		// buildConversation adds a trailing "done" assistant msg (no thinking),
		// making it the last — so all thinking blocks are stripped.
		expect(getThinkingBlocks(pruned)).toHaveLength(0);
	});

	it("keeps thinking in the last round even when tool results are pruned", () => {
		// Build without trailing "done" so round 3 is the last assistant message.
		const msgs: Message[] = [
			userMsg("task"),
			assistantMsg("s1", ["SearchWeb"], "t1"),
			toolResult("SearchWeb", "search1"),
			assistantMsg("s2", ["SearchWeb"], "t2"),
			toolResult("SearchWeb", "search2"),
			assistantMsg("s3", ["SearchWeb"], "t3"),
			toolResult("SearchWeb", "search3"),
		];

		const pruned = pruneEphemeralResults(msgs, 1);

		const toolTexts = getToolResultText(pruned, "SearchWeb");
		expect(toolTexts[0]).toBe(PRUNED_STUB); // round1
		expect(toolTexts[1]).toBe(PRUNED_STUB); // round2
		expect(toolTexts[2]).toBe("search3"); // round3 kept

		const thinking = getThinkingBlocks(pruned);
		expect(thinking).toHaveLength(1);
		expect(thinking[0].text).toBe("t3");
	});

	it("returns unchanged copy when not enough rounds to prune", () => {
		const msgs = buildConversation([
			{ tools: [{ name: "Bash", result: "only" }] },
		]);
		const pruned = pruneEphemeralResults(msgs, 2);
		// Single round — nothing to prune
		const texts = getToolResultText(pruned, "Bash");
		expect(texts[0]).toBe("only");
	});

	it("handles empty message array", () => {
		expect(pruneEphemeralResults([], 2)).toEqual([]);
	});
});
