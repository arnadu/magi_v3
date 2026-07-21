import { beforeEach, describe, expect, it } from "vitest";
import {
	type AgentStatsRepository,
	type AgentTurnStats,
	type MissionStats,
	StatsCollector,
} from "../src/agent-stats.js";

// ---------------------------------------------------------------------------
// In-memory fake repository — exercises the collector's aggregation logic
// without MongoDB. Mirrors the upsert (keyed) + $inc semantics of the real repo.
// ---------------------------------------------------------------------------

class FakeStatsRepository implements AgentStatsRepository {
	turns = new Map<string, AgentTurnStats>();
	missions = new Map<string, MissionStats>();

	private turnKey(s: {
		missionId: string;
		agentId: string;
		turnNumber: number;
	}): string {
		return `${s.missionId}|${s.agentId}|${s.turnNumber}`;
	}
	private missionKey(missionId: string, agentId: string): string {
		return `${missionId}|${agentId}`;
	}

	async upsertTurn(stats: AgentTurnStats): Promise<void> {
		// Store a deep copy so later in-memory mutation does not change history.
		this.turns.set(this.turnKey(stats), structuredClone(stats));
	}

	async incrementMission(delta: {
		missionId: string;
		agentId: string;
		costUsd: number;
		llmCallCount: number;
		consecutiveZeroOutputTurns: number;
		lastTurnAt: Date;
	}): Promise<MissionStats> {
		const key = this.missionKey(delta.missionId, delta.agentId);
		const prior = this.missions.get(key);
		const next: MissionStats = {
			missionId: delta.missionId,
			agentId: delta.agentId,
			lifetimeCostUsd: (prior?.lifetimeCostUsd ?? 0) + delta.costUsd,
			lifetimeLlmCallCount:
				(prior?.lifetimeLlmCallCount ?? 0) + delta.llmCallCount,
			lifetimeTurnCount: (prior?.lifetimeTurnCount ?? 0) + 1,
			consecutiveZeroOutputTurns: delta.consecutiveZeroOutputTurns,
			lastTurnAt: delta.lastTurnAt,
		};
		this.missions.set(key, next);
		return next;
	}

	async loadMission(
		missionId: string,
		agentId: string,
	): Promise<MissionStats | null> {
		return this.missions.get(this.missionKey(missionId, agentId)) ?? null;
	}

	async incrementLifetimeCostOnly(delta: {
		missionId: string;
		agentId: string;
		costUsd: number;
		llmCallCount: number;
	}): Promise<MissionStats> {
		const key = this.missionKey(delta.missionId, delta.agentId);
		const prior = this.missions.get(key);
		const next: MissionStats = {
			missionId: delta.missionId,
			agentId: delta.agentId,
			lifetimeCostUsd: (prior?.lifetimeCostUsd ?? 0) + delta.costUsd,
			lifetimeLlmCallCount:
				(prior?.lifetimeLlmCallCount ?? 0) + delta.llmCallCount,
			lifetimeTurnCount: prior?.lifetimeTurnCount ?? 0,
			consecutiveZeroOutputTurns: prior?.consecutiveZeroOutputTurns ?? 0,
			lastTurnAt: prior?.lastTurnAt ?? new Date(),
		};
		this.missions.set(key, next);
		return next;
	}

	async readMissionSnapshot(
		missionId: string,
	): Promise<
		Array<{ agentId: string; lifetimeCostUsd: number; turnCostUsd: number }>
	> {
		const agentIds = new Set<string>();
		for (const m of this.missions.values()) {
			if (m.missionId === missionId) agentIds.add(m.agentId);
		}
		for (const t of this.turns.values()) {
			if (t.missionId === missionId && t.status === "running") {
				agentIds.add(t.agentId);
			}
		}
		return [...agentIds].map((agentId) => {
			const lifetimeCostUsd =
				this.missions.get(this.missionKey(missionId, agentId))
					?.lifetimeCostUsd ?? 0;
			const turnCostUsd = [...this.turns.values()]
				.filter(
					(t) =>
						t.missionId === missionId &&
						t.agentId === agentId &&
						t.status === "running",
				)
				.reduce((sum, t) => sum + t.costUsd, 0);
			return { agentId, lifetimeCostUsd, turnCostUsd };
		});
	}

	async queryTurns(filter: {
		missionId: string;
		agentId?: string;
	}): Promise<AgentTurnStats[]> {
		return [...this.turns.values()]
			.filter(
				(t) =>
					t.missionId === filter.missionId &&
					(filter.agentId === undefined || t.agentId === filter.agentId),
			)
			.sort((a, b) => a.turnNumber - b.turnNumber);
	}

	async reconcileStaleRunning(
		missionId: string,
		agentId: string,
		currentTurnNumber: number,
	): Promise<number> {
		let count = 0;
		for (const t of this.turns.values()) {
			if (
				t.missionId === missionId &&
				t.agentId === agentId &&
				t.status === "running" &&
				t.turnNumber !== currentTurnNumber
			) {
				t.status = "aborted";
				t.completedAt = new Date();
				count++;
			}
		}
		return count;
	}
}

const MISSION = "m1";
const AGENT = "analyst";

describe("StatsCollector", () => {
	let repo: FakeStatsRepository;
	let collector: StatsCollector;

	beforeEach(() => {
		repo = new FakeStatsRepository();
		collector = new StatsCollector(repo);
	});

	function turnDoc(turnNumber = 0): AgentTurnStats | undefined {
		return repo.turns.get(`${MISSION}|${AGENT}|${turnNumber}`);
	}

	it("writes a running turn doc on startTurn", async () => {
		await collector.startTurn(MISSION, AGENT, 0, false);
		const doc = turnDoc();
		expect(doc?.status).toBe("running");
		expect(doc?.llmCallCount).toBe(0);
		expect(doc?.reflectionTriggered).toBe(false);
	});

	it("reconciles a stale 'running' turn left over from a crash/hang when the next turn starts", async () => {
		// Turn 0 starts and never finalizes (simulating a crash or an
		// unrecovered hang — no endTurn call).
		await collector.startTurn(MISSION, AGENT, 0, false);
		expect(turnDoc(0)?.status).toBe("running");

		// Turn 1 starting is proof turn 0 is no longer really running.
		await collector.startTurn(MISSION, AGENT, 1, false);
		expect(turnDoc(0)?.status).toBe("aborted");
		expect(turnDoc(0)?.completedAt).toBeInstanceOf(Date);
		// The NEW turn itself must not be touched by its own reconciliation pass.
		expect(turnDoc(1)?.status).toBe("running");
	});

	it("does not reconcile a turn that already finalized normally", async () => {
		await collector.startTurn(MISSION, AGENT, 0, false);
		await collector.endTurn(AGENT, "complete");
		expect(turnDoc(0)?.status).toBe("complete");

		await collector.startTurn(MISSION, AGENT, 1, false);
		// Still 'complete', not overwritten to 'aborted'.
		expect(turnDoc(0)?.status).toBe("complete");
	});

	it("aggregates LLM calls and tracks peak context", async () => {
		await collector.startTurn(MISSION, AGENT, 0, false);
		await collector.recordLlmCall(AGENT, {
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 1000,
			cacheWriteTokens: 0,
			costUsd: 0.01,
		});
		await collector.recordLlmCall(AGENT, {
			inputTokens: 50,
			outputTokens: 10,
			cacheReadTokens: 5000,
			cacheWriteTokens: 200,
			costUsd: 0.02,
		});
		const doc = turnDoc();
		expect(doc?.llmCallCount).toBe(2);
		expect(doc?.inputTokens).toBe(150);
		expect(doc?.outputTokens).toBe(30);
		expect(doc?.costUsd).toBeCloseTo(0.03, 10);
		// peak = max(100+1000+0, 50+5000+200) = 5250
		expect(doc?.peakContextTokens).toBe(5250);
	});

	it("counts tools, errors, and extracts files / messages / urls", async () => {
		await collector.startTurn(MISSION, AGENT, 0, false);
		await collector.recordToolResult(AGENT, {
			toolName: "Bash",
			args: { command: "ls" },
			isError: false,
		});
		await collector.recordToolResult(AGENT, {
			toolName: "Bash",
			args: { command: "boom" },
			isError: true,
		});
		await collector.recordToolResult(AGENT, {
			toolName: "WriteFile",
			args: { path: "/shared/report.md", content: "x" },
			isError: false,
		});
		await collector.recordToolResult(AGENT, {
			toolName: "PostMessage",
			args: { to: ["lead", "user"], subject: "status", body: "done" },
			isError: false,
		});
		await collector.recordToolResult(AGENT, {
			toolName: "FetchUrl",
			args: { url: "https://example.com" },
			isError: false,
		});

		const doc = turnDoc();
		expect(doc?.toolCalls).toEqual({
			Bash: 2,
			WriteFile: 1,
			PostMessage: 1,
			FetchUrl: 1,
		});
		expect(doc?.toolErrors).toEqual({ Bash: 1 });
		expect(doc?.filesWritten).toEqual([
			{ path: "/shared/report.md", tool: "WriteFile" },
		]);
		expect(doc?.messagesSent).toEqual([
			{ to: ["lead", "user"], subject: "status" },
		]);
		expect(doc?.urlsVisited).toEqual(["https://example.com"]);
	});

	it("finalizes the turn and increments lifetime totals exactly once", async () => {
		await collector.startTurn(MISSION, AGENT, 0, false);
		await collector.recordLlmCall(AGENT, {
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.05,
		});
		await collector.recordToolResult(AGENT, {
			toolName: "WriteFile",
			args: { path: "/shared/a.txt" },
			isError: false,
		});
		await collector.endTurn(AGENT);

		const doc = turnDoc();
		expect(doc?.status).toBe("complete");
		expect(doc?.completedAt).toBeInstanceOf(Date);
		expect(doc?.durationSeconds).toBeGreaterThanOrEqual(0);

		const mission = await repo.loadMission(MISSION, AGENT);
		expect(mission?.lifetimeCostUsd).toBeCloseTo(0.05, 10);
		expect(mission?.lifetimeLlmCallCount).toBe(1);
		expect(mission?.lifetimeTurnCount).toBe(1);
		// produced a file → streak resets to 0
		expect(mission?.consecutiveZeroOutputTurns).toBe(0);
	});

	it("tracks consecutive zero-output turns and resets on output", async () => {
		// Turn 0: no files, no messages → streak 1
		await collector.startTurn(MISSION, AGENT, 0, false);
		await collector.endTurn(AGENT);
		expect(
			(await repo.loadMission(MISSION, AGENT))?.consecutiveZeroOutputTurns,
		).toBe(1);

		// Turn 1: still nothing → streak 2
		await collector.startTurn(MISSION, AGENT, 1, false);
		await collector.endTurn(AGENT);
		expect(
			(await repo.loadMission(MISSION, AGENT))?.consecutiveZeroOutputTurns,
		).toBe(2);

		// Turn 2: sends a message → streak resets to 0
		await collector.startTurn(MISSION, AGENT, 2, false);
		await collector.recordToolResult(AGENT, {
			toolName: "PostMessage",
			args: { to: ["user"], subject: "hi", body: "there" },
			isError: false,
		});
		await collector.endTurn(AGENT);
		const mission = await repo.loadMission(MISSION, AGENT);
		expect(mission?.consecutiveZeroOutputTurns).toBe(0);
		expect(mission?.lifetimeTurnCount).toBe(3);
	});

	it("readLifetime reads persisted totals fresh — survives a restart with no pre-load step", async () => {
		// Pre-seed a mission-stats doc as if a prior daemon had run two turns.
		await repo.incrementMission({
			missionId: MISSION,
			agentId: AGENT,
			costUsd: 1.0,
			llmCallCount: 10,
			consecutiveZeroOutputTurns: 2,
			lastTurnAt: new Date(),
		});

		// A brand-new collector (simulates a daemon restart) has no cache to warm —
		// readLifetime hits the repo directly, with no startTurn prerequisite.
		const fresh = new StatsCollector(repo);
		const lifetime = await fresh.readLifetime(MISSION, AGENT);
		expect(lifetime?.lifetimeCostUsd).toBeCloseTo(1.0, 10);
		expect(lifetime?.consecutiveZeroOutputTurns).toBe(2);

		// A zero-output turn continues the streak from the persisted value —
		// endTurn reads it fresh internally, not from any in-memory cache.
		await fresh.startTurn(MISSION, AGENT, 5, false);
		await fresh.endTurn(AGENT);
		const mission = await repo.loadMission(MISSION, AGENT);
		expect(mission?.consecutiveZeroOutputTurns).toBe(3);
		expect(mission?.lifetimeCostUsd).toBeCloseTo(1.0, 10);
	});

	it("readLifetime reflects a change made by a different collector instance immediately", async () => {
		// Simulates two daemon processes (or a daemon restart) sharing one repo —
		// there is no in-memory cache to go stale between them.
		const other = new StatsCollector(repo);
		await other.startTurn(MISSION, AGENT, 0, false);
		await other.recordLlmCall(AGENT, {
			inputTokens: 1,
			outputTokens: 1,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 2.5,
		});
		await other.endTurn(AGENT);

		// A second, independent collector reads the same fresh total.
		const second = new StatsCollector(repo);
		expect(
			(await second.readLifetime(MISSION, AGENT))?.lifetimeCostUsd,
		).toBeCloseTo(2.5, 10);
	});

	it("readMissionSnapshot combines persisted lifetime cost with each agent's in-flight turn cost", async () => {
		// Agent "a": a finished prior turn (persisted) plus a currently running turn.
		await repo.incrementMission({
			missionId: MISSION,
			agentId: "a",
			costUsd: 1.0,
			llmCallCount: 1,
			consecutiveZeroOutputTurns: 0,
			lastTurnAt: new Date(),
		});
		await collector.startTurn(MISSION, "a", 1, false);
		await collector.recordLlmCall("a", {
			inputTokens: 1,
			outputTokens: 1,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.5,
		});
		// Agent "b": only a persisted lifetime total, nothing running right now.
		await repo.incrementMission({
			missionId: MISSION,
			agentId: "b",
			costUsd: 3.0,
			llmCallCount: 1,
			consecutiveZeroOutputTurns: 0,
			lastTurnAt: new Date(),
		});

		const snapshot = await collector.readMissionSnapshot(MISSION);
		const byAgent = new Map(snapshot.map((s) => [s.agentId, s]));
		expect(byAgent.get("a")).toEqual({
			agentId: "a",
			lifetimeCostUsd: 1.0,
			turnCostUsd: 0.5,
		});
		expect(byAgent.get("b")).toEqual({
			agentId: "b",
			lifetimeCostUsd: 3.0,
			turnCostUsd: 0,
		});
	});

	it("recordReflectionCost persists lifetime cost without touching lifetimeTurnCount", async () => {
		await collector.recordReflectionCost(MISSION, AGENT, 0.75);
		const mission = await repo.loadMission(MISSION, AGENT);
		expect(mission?.lifetimeCostUsd).toBeCloseTo(0.75, 10);
		expect(mission?.lifetimeLlmCallCount).toBe(1);
		expect(mission?.lifetimeTurnCount).toBe(0);

		// A second reflection call accumulates rather than overwriting.
		await collector.recordReflectionCost(MISSION, AGENT, 0.25);
		const updated = await repo.loadMission(MISSION, AGENT);
		expect(updated?.lifetimeCostUsd).toBeCloseTo(1.0, 10);
		expect(updated?.lifetimeLlmCallCount).toBe(2);
	});

	it("isolates concurrent agents by id", async () => {
		await collector.startTurn(MISSION, "a", 0, false);
		await collector.startTurn(MISSION, "b", 0, false);
		await collector.recordLlmCall("a", {
			inputTokens: 1,
			outputTokens: 1,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.1,
		});
		await collector.recordToolResult("b", {
			toolName: "Bash",
			args: {},
			isError: false,
		});
		expect(collector.getTurn("a")?.llmCallCount).toBe(1);
		expect(collector.getTurn("a")?.toolCalls).toEqual({});
		expect(collector.getTurn("b")?.llmCallCount).toBe(0);
		expect(collector.getTurn("b")?.toolCalls).toEqual({ Bash: 1 });
	});
});
