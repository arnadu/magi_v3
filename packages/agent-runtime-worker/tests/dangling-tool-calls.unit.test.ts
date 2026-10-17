import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import type { StoredMessage } from "../src/conversation-repository.js";
import {
	convertToLlm,
	findDanglingToolCalls,
	syntheticResultsFor,
} from "../src/reflection.js";

const assistant = (turn: number, ids: string[]): StoredMessage => ({
	turnNumber: turn,
	message: {
		role: "assistant",
		content: ids.map((id) => ({
			type: "toolCall",
			id,
			name: "RequestResourceUpgrade",
			arguments: {},
		})),
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
		timestamp: 1,
	} as AssistantMessage,
});
const result = (turn: number, id: string): StoredMessage => ({
	turnNumber: turn,
	message: {
		role: "toolResult",
		toolCallId: id,
		toolName: "RequestResourceUpgrade",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 2,
	},
});

describe("dangling tool calls (issue #56)", () => {
	it("finds tool calls without a stored result and builds one persistent synthetic result each", () => {
		const history = [
			assistant(3, ["x", "y"]),
			result(3, "x"),
			assistant(4, ["z"]),
		];
		const dangling = findDanglingToolCalls(history);
		expect(dangling).toEqual([
			{ turnNumber: 3, id: "y", name: "RequestResourceUpgrade" },
			{ turnNumber: 4, id: "z", name: "RequestResourceUpgrade" },
		]);
		const repaired = [...history, ...syntheticResultsFor(dangling)];
		expect(findDanglingToolCalls(repaired)).toEqual([]);
		// convertToLlm no longer has to inject anything: the pairing is complete.
		const llm = convertToLlm(repaired);
		const ids = llm
			.filter((m) => m.role === "toolResult")
			.map((m) => (m as { toolCallId: string }).toolCallId)
			.sort();
		expect(ids).toEqual(["x", "y", "z"]);
	});

	it("returns nothing for a complete history", () => {
		expect(
			findDanglingToolCalls([assistant(1, ["a"]), result(1, "a")]),
		).toEqual([]);
	});
});
