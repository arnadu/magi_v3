/**
 * CST-2 (sprint-28f audit): reaching the mission spend cap used to stop only
 * new dispatches — a running turn kept calling the LLM until it ended. A turn
 * now waits before its next LLM call while the cap holds the mission paused,
 * and carries on when the cap is raised; an abort ends the wait.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentRunContext } from "../src/agent-runner.js";
import { createTurnHooks, type TurnState } from "../src/agent-runner-turn.js";
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

const tick = () => new Promise((r) => setTimeout(r, 10));

/** A pause the test lifts by hand, shaped like MonitorServer's. */
function pause(paused: boolean) {
	let release: () => void = () => {};
	const budget = {
		paused,
		isPaused: () => budget.paused,
		wait: vi.fn(
			() =>
				new Promise<void>((r) => {
					release = () => {
						budget.paused = false;
						r();
					};
				}),
		),
		lift: () => release(),
	};
	return budget;
}

function gateFor(
	budget: ReturnType<typeof pause>,
	signal?: AbortSignal,
): () => Promise<void> {
	const ctx = { budget } as unknown as AgentRunContext;
	const hooks = createTurnHooks(
		ctx,
		{ id: "a1" } as never,
		"m1",
		{ turnNumber: 0, callSeq: 0 } as TurnState,
		() => undefined,
		signal,
	);
	if (!hooks.beforeLlmCall) throw new Error("no budget gate built");
	return hooks.beforeLlmCall;
}

describe("the spend-cap gate before each LLM call", () => {
	it("passes straight through when the mission is not paused", async () => {
		const budget = pause(false);
		await gateFor(budget)();
		expect(budget.wait).not.toHaveBeenCalled();
	});

	it("holds a running turn's next LLM call until the cap is raised, then continues", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const budget = pause(true);
		const completeFn = vi.fn<CompleteFn>(async () => reply("done"));
		const run = runInnerLoop({
			model: CLAUDE_SONNET,
			getSystemPrompt: () => "s",
			task: "t",
			tools: [],
			completeFn,
			beforeLlmCall: gateFor(budget),
		});
		await tick();
		expect(completeFn).not.toHaveBeenCalled();
		budget.lift();
		const result = await run;
		expect(completeFn).toHaveBeenCalledTimes(1);
		expect(result.turnCount).toBe(1);
	});

	it("ends the wait on abort, and the loop makes no call", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const budget = pause(true);
		const ac = new AbortController();
		const completeFn = vi.fn<CompleteFn>(async () => reply("done"));
		const run = runInnerLoop({
			model: CLAUDE_SONNET,
			getSystemPrompt: () => "s",
			task: "t",
			tools: [],
			signal: ac.signal,
			completeFn,
			beforeLlmCall: gateFor(budget, ac.signal),
		});
		await tick();
		ac.abort();
		await run;
		expect(completeFn).not.toHaveBeenCalled();
	});
});
