import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { type CompleteFn, runInnerLoop } from "../src/loop.js";
import { CLAUDE_SONNET } from "../src/models.js";

/**
 * A "well-behaved" fake provider: never resolves on its own (simulating a
 * stalled connection), but — like the real Anthropic provider — resolves with
 * a stopReason:"aborted" message once its signal is aborted, rather than
 * hanging forever. This is the exact contract runInnerLoop's per-call deadline
 * (loop.ts's deriveDeadline) relies on to actually recover a hung call instead
 * of just setting a flag nothing observes.
 */
function hangingCompleteFn(): CompleteFn {
	return (_model, _context, options) =>
		new Promise<AssistantMessage>((resolve) => {
			options?.signal?.addEventListener(
				"abort",
				() => {
					resolve({
						role: "assistant",
						content: [],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-sonnet-4-6",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						},
						stopReason: "aborted",
						timestamp: Date.now(),
					});
				},
				{ once: true },
			);
			// No timer of its own — if nothing aborts `options.signal`, this
			// promise never settles, exactly like a truly stalled connection.
		});
}

describe("runInnerLoop llmCallTimeoutMs", () => {
	it("recovers a hung LLM call within llmCallTimeoutMs instead of hanging forever", async () => {
		const started = Date.now();
		const result = await runInnerLoop({
			model: CLAUDE_SONNET,
			getSystemPrompt: () => "system",
			task: "do something",
			tools: [],
			completeFn: hangingCompleteFn(),
			llmCallTimeoutMs: 50,
		});
		const elapsedMs = Date.now() - started;

		// Bounded by the deadline, not by some much larger/absent limit.
		expect(elapsedMs).toBeLessThan(2000);
		const last = result.messages.at(-1);
		expect(last?.role).toBe("assistant");
		expect((last as AssistantMessage).stopReason).toBe("aborted");
	});

	it("does not fire the deadline for a call that resolves promptly", async () => {
		const fast: CompleteFn = async () => ({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
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
		});
		const result = await runInnerLoop({
			model: CLAUDE_SONNET,
			getSystemPrompt: () => "system",
			task: "do something",
			tools: [],
			completeFn: fast,
			llmCallTimeoutMs: 50,
		});
		const last = result.messages.at(-1) as AssistantMessage;
		expect(last.stopReason).toBe("stop");
	});
});
