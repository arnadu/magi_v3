/**
 * The control-plane copilot's spend containment (CST-3): a cap always binds
 * (the user's own or the default), spend includes the turn in flight, and a
 * turn is stopped at the cap or at its wall-clock bound.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkCopilotSpendCap,
	createCopilotTurnGuard,
	DEFAULT_COPILOT_SPEND_CAP_USD,
	effectiveCopilotCap,
	readCopilotSpend,
} from "../src/copilot-spend.js";
import { fakeDb } from "./support/fake-db.js";

const stats = (costUsd: number) => ({
	missionId: "copilot-u1",
	agentId: "copilot",
	lifetimeCostUsd: costUsd,
	lifetimeLlmCallCount: 1,
	lifetimeTurnCount: 1,
	consecutiveZeroOutputTurns: 0,
	lastTurnAt: new Date(),
});

const runningTurn = (costUsd: number) => ({
	missionId: "copilot-u1",
	agentId: "copilot",
	turnNumber: 4,
	status: "running",
	costUsd,
	llmCallCount: 1,
});

afterEach(() => {
	vi.useRealTimers();
});

describe("copilot spend cap", () => {
	it("no cap set: the default binds — there is no uncapped copilot", async () => {
		const { db } = fakeDb({
			users: [{ uid: "u1" }],
			missionStats: [stats(DEFAULT_COPILOT_SPEND_CAP_USD)],
		});
		expect(await effectiveCopilotCap(db, "u1")).toEqual({
			capUsd: DEFAULT_COPILOT_SPEND_CAP_USD,
			isDefault: true,
		});
		expect(await checkCopilotSpendCap(db, "u1")).toMatch(/spend cap reached/);
	});

	it("under the user's cap: allowed", async () => {
		const { db } = fakeDb({
			users: [{ uid: "u1", copilotSpendCapUsd: 5 }],
			missionStats: [stats(4.99)],
		});
		expect(await checkCopilotSpendCap(db, "u1")).toBeNull();
	});

	it("at or over the cap: refused with spent and cap", async () => {
		const { db } = fakeDb({
			users: [{ uid: "u1", copilotSpendCapUsd: 5 }],
			missionStats: [stats(5)],
		});
		expect(await checkCopilotSpendCap(db, "u1")).toBe(
			"Copilot spend cap reached ($5.00 / $5.00). Raise the cap in the Copilot → Limits tab to continue.",
		);
	});

	it("counts the turn in flight, which missionStats only gets at turn end", async () => {
		const { db } = fakeDb({
			users: [{ uid: "u1", copilotSpendCapUsd: 5 }],
			missionStats: [stats(3)],
			agentTurnStats: [runningTurn(2.5)],
		});
		expect(await readCopilotSpend(db, "copilot-u1")).toBeCloseTo(5.5);
		expect(await checkCopilotSpendCap(db, "u1")).toMatch(/\$5\.50 \/ \$5\.00/);
	});

	it("a copilot that never ran has spent nothing", async () => {
		const { db } = fakeDb({ missionStats: [] });
		expect(await readCopilotSpend(db, "copilot-u2")).toBe(0);
	});
});

describe("createCopilotTurnGuard", () => {
	it("stops the turn when a check after an LLM call finds the cap reached", async () => {
		const { db } = fakeDb({
			users: [{ uid: "u1", copilotSpendCapUsd: 5 }],
			missionStats: [stats(1)],
			agentTurnStats: [runningTurn(4.5)],
		});
		const guard = createCopilotTurnGuard({
			db,
			userId: "u1",
			parent: new AbortController().signal,
		});
		await guard.checkAfterCall();
		expect(guard.signal.aborted).toBe(true);
		expect(guard.stopReason()).toMatch(/spend cap reached/);
		guard.dispose();
	});

	it("leaves a turn under the cap running", async () => {
		const { db } = fakeDb({
			users: [{ uid: "u1", copilotSpendCapUsd: 5 }],
			missionStats: [stats(1)],
		});
		const guard = createCopilotTurnGuard({
			db,
			userId: "u1",
			parent: new AbortController().signal,
		});
		await guard.checkAfterCall();
		expect(guard.signal.aborted).toBe(false);
		guard.dispose();
	});

	it("stops the turn at its wall-clock bound", () => {
		vi.useFakeTimers();
		const { db } = fakeDb({});
		const guard = createCopilotTurnGuard({
			db,
			userId: "u1",
			parent: new AbortController().signal,
			maxTurnMs: 60_000,
		});
		vi.advanceTimersByTime(60_001);
		expect(guard.signal.aborted).toBe(true);
		expect(guard.stopReason()).toMatch(/1-minute limit/);
		guard.dispose();
	});

	it("follows the daemon's shutdown", () => {
		const { db } = fakeDb({});
		const parent = new AbortController();
		const guard = createCopilotTurnGuard({
			db,
			userId: "u1",
			parent: parent.signal,
		});
		parent.abort();
		expect(guard.signal.aborted).toBe(true);
		guard.dispose();
	});
});
