/**
 * runCopilotTurn (CST-3): the cap is re-checked after each LLM call; a turn
 * stopped at the cap ends normally and is reported, while a real failure
 * still propagates so the watch loop can retry (and eventually set it aside).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const runAgent = vi.fn();
vi.mock("@magi/agent-runtime-worker", async (importOriginal) => ({
	...(await importOriginal<typeof import("@magi/agent-runtime-worker")>()),
	runAgent: (...args: unknown[]) => runAgent(...args),
}));

const { runCopilotTurn } = await import("../src/copilot-turn.js");
const { fakeDb } = await import("./support/fake-db.js");

const assistant = { role: "assistant", stopReason: "toolUse", content: [] };

function deps(spentUsd: number) {
	const events: Array<{ type: string; data: unknown }> = [];
	const { db } = fakeDb({
		users: [{ uid: "u1", copilotSpendCapUsd: 5 }],
		missionStats: [
			{
				missionId: "copilot-u1",
				agentId: "copilot",
				lifetimeCostUsd: spentUsd,
				lifetimeLlmCallCount: 1,
				lifetimeTurnCount: 1,
				consecutiveZeroOutputTurns: 0,
			},
		],
	});
	return {
		events,
		deps: {
			db,
			missionId: "copilot-u1",
			userId: "u1",
			agentId: "copilot",
			ctx: {} as never,
			pushEvent: (type: string, data: unknown) => events.push({ type, data }),
		},
	};
}

beforeEach(() => {
	runAgent.mockReset();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("runCopilotTurn", () => {
	it("stops the turn after the LLM call that reached the cap, and reports why", async () => {
		const d = deps(6);
		let signalSeen: AbortSignal | undefined;
		runAgent.mockImplementation(
			async (
				_id: string,
				_msgs: unknown,
				ctx: { onMessage: (m: unknown) => Promise<void> },
				signal: AbortSignal,
			) => {
				signalSeen = signal;
				await ctx.onMessage(assistant);
				if (signal.aborted) throw new DOMException("Aborted", "AbortError");
			},
		);
		await expect(
			runCopilotTurn(d.deps, [], new AbortController().signal),
		).resolves.toBeUndefined();
		expect(signalSeen?.aborted).toBe(true);
		expect(JSON.stringify(d.events)).toMatch(
			/stopped mid-turn: Copilot spend cap reached/,
		);
	});

	it("lets a real failure propagate so the loop can retry", async () => {
		const d = deps(1);
		runAgent.mockRejectedValue(new Error("provider down"));
		await expect(
			runCopilotTurn(d.deps, [], new AbortController().signal),
		).rejects.toThrow("provider down");
	});
});
