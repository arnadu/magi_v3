import type { Message, ToolResultMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentRunContext } from "../src/agent-runner.js";
import { createTurnHooks, type TurnState } from "../src/agent-runner-turn.js";
import {
	consecutiveIdenticalFailures,
	REPEATED_FAILURE_THRESHOLD,
	withRepeatNote,
} from "../src/repeated-tool-failure.js";

function result(
	toolName: string,
	text: string,
	isError = true,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "c",
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: 0,
	};
}

const unknown = "PostMessage: unknown recipients";

describe("repeated tool failures", () => {
	it("counts this failure and the identical ones before it, skipping other tools", () => {
		const history: Message[] = [
			result("PostMessage", unknown),
			result("Bash", "ok", false),
			result("PostMessage", unknown),
		];
		expect(
			consecutiveIdenticalFailures(history, result("PostMessage", unknown)),
		).toBe(3);
	});

	it("a success or a different error of the same tool ends the run", () => {
		expect(
			consecutiveIdenticalFailures(
				[result("PostMessage", unknown), result("PostMessage", "sent", false)],
				result("PostMessage", unknown),
			),
		).toBe(1);
		expect(
			consecutiveIdenticalFailures(
				[
					result("PostMessage", unknown),
					result("PostMessage", "body too large"),
				],
				result("PostMessage", unknown),
			),
		).toBe(1);
		expect(
			consecutiveIdenticalFailures([], result("PostMessage", "sent", false)),
		).toBe(0);
	});

	it("adds the note from the threshold on, and still counts noted results as the same error", () => {
		const below = withRepeatNote(
			result("PostMessage", unknown),
			REPEATED_FAILURE_THRESHOLD - 1,
		);
		expect(below.content).toHaveLength(1);
		const noted = withRepeatNote(
			result("PostMessage", unknown),
			REPEATED_FAILURE_THRESHOLD,
		);
		expect(noted.content).toHaveLength(2);
		expect((noted.content[1] as { text: string }).text).toContain(
			"failed 3 times in a row",
		);
		const history: Message[] = [
			result("PostMessage", unknown),
			result("PostMessage", unknown),
			noted,
		];
		expect(
			consecutiveIdenticalFailures(history, result("PostMessage", unknown)),
		).toBe(4);
	});
});

describe("tool-repeated-failure anomaly", () => {
	it("is recorded once per run of identical failures, at the threshold", async () => {
		const recorded: Array<{ category: string; agentId?: string }> = [];
		const ctx = {
			anomalyRecorder: {
				record: async (a: { category: string }) => void recorded.push(a),
			},
		} as unknown as AgentRunContext;
		const hooks = createTurnHooks(
			ctx,
			{ id: "copilot" } as never,
			"m1",
			{ turnNumber: 7, callSeq: 0 } as TurnState,
			() => undefined,
		);
		for (const repeatedFailures of [1, 2, 3, 4, 5]) {
			await hooks.onToolResult?.({
				toolName: "PostMessage",
				args: {},
				isError: true,
				repeatedFailures,
			});
		}
		expect(recorded).toEqual([
			expect.objectContaining({
				category: "tool-repeated-failure",
				agentId: "copilot",
			}),
		]);
	});
});
