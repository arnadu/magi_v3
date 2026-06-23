import { describe, expect, it } from "vitest";
import type { AgentTurnStats, MissionStats } from "../src/agent-stats.js";
import {
	buildRules,
	DEFAULT_SOFT_LIMITS,
	evaluateLimits,
	isTurnMetric,
	type LimitConfig,
} from "../src/limits.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function turn(overrides: Partial<AgentTurnStats> = {}): AgentTurnStats {
	return {
		missionId: "m",
		agentId: "a",
		turnNumber: 0,
		startedAt: new Date(),
		status: "running",
		llmCallCount: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
		peakContextTokens: 0,
		toolCalls: {},
		toolErrors: {},
		filesWritten: [],
		messagesSent: [],
		urlsVisited: [],
		reflectionTriggered: false,
		...overrides,
	};
}

function lifetime(overrides: Partial<MissionStats> = {}): MissionStats {
	return {
		missionId: "m",
		agentId: "a",
		lifetimeCostUsd: 0,
		lifetimeLlmCallCount: 0,
		lifetimeTurnCount: 0,
		consecutiveZeroOutputTurns: 0,
		lastTurnAt: new Date(),
		...overrides,
	};
}

const ids = (cfg?: LimitConfig) => buildRules(cfg).map((r) => r.id);

// ---------------------------------------------------------------------------
// buildRules
// ---------------------------------------------------------------------------

describe("buildRules", () => {
	it("emits the conservative soft defaults when no config is given", () => {
		const rules = buildRules();
		expect(ids()).toEqual([
			"soft:warnLlmCallsPerTurn",
			"soft:warnPeakContextTokens",
			"soft:warnToolErrorsPerTurn",
			"soft:warnConsecutiveZeroOutputTurns",
		]);
		// All defaulted rules are soft — no hard rule appears without config.
		expect(rules.every((r) => r.severity === "soft")).toBe(true);
		const callRule = rules.find((r) => r.id === "soft:warnLlmCallsPerTurn");
		expect(callRule?.threshold).toBe(DEFAULT_SOFT_LIMITS.warnLlmCallsPerTurn);
	});

	it("adds hard rules only when explicitly configured", () => {
		const rules = buildRules({
			maxLlmCallsPerTurn: 60,
			maxCostPerTurnUsd: 0.5,
			maxLifetimeCostUsd: 10,
		});
		const hard = rules.filter((r) => r.severity === "hard").map((r) => r.id);
		expect(hard).toEqual([
			"hard:maxLlmCallsPerTurn",
			"hard:maxCostPerTurnUsd",
			"hard:maxLifetimeCostUsd",
		]);
	});

	it("lets an explicit soft override replace the default threshold", () => {
		const rules = buildRules({ warnLlmCallsPerTurn: 5 });
		const r = rules.find((x) => x.id === "soft:warnLlmCallsPerTurn");
		expect(r?.threshold).toBe(5);
	});

	it("disables a soft rule when its threshold is set to 0", () => {
		expect(ids({ warnLlmCallsPerTurn: 0 })).not.toContain(
			"soft:warnLlmCallsPerTurn",
		);
	});

	it("ignores non-positive hard thresholds", () => {
		expect(ids({ maxLlmCallsPerTurn: 0 })).not.toContain(
			"hard:maxLlmCallsPerTurn",
		);
	});
});

// ---------------------------------------------------------------------------
// evaluateLimits
// ---------------------------------------------------------------------------

describe("evaluateLimits", () => {
	it("returns no breach when values are at or below threshold", () => {
		const rules = buildRules({ maxLlmCallsPerTurn: 10 });
		// strictly greater than → a value equal to the threshold does not breach
		expect(
			evaluateLimits(turn({ llmCallCount: 10 }), undefined, rules),
		).toEqual([]);
	});

	it("detects a hard per-turn LLM call breach", () => {
		const rules = buildRules({ maxLlmCallsPerTurn: 10 });
		const breaches = evaluateLimits(
			turn({ llmCallCount: 11 }),
			undefined,
			rules,
		);
		expect(breaches).toHaveLength(1);
		expect(breaches[0].rule.id).toBe("hard:maxLlmCallsPerTurn");
		expect(breaches[0].value).toBe(11);
	});

	it("sums per-tool errors for the toolErrors metric", () => {
		const rules = buildRules({
			warnToolErrorsPerTurn: 3,
			warnLlmCallsPerTurn: 0,
		});
		const breaches = evaluateLimits(
			turn({ toolErrors: { BrowseWeb: 2, FetchUrl: 2 } }),
			undefined,
			rules.filter((r) => r.metric === "toolErrors"),
		);
		expect(breaches).toHaveLength(1);
		expect(breaches[0].value).toBe(4);
	});

	it("counts lifetime cost as persisted lifetime + current turn (trips mid-turn)", () => {
		const rules = buildRules({ maxLifetimeCostUsd: 10 });
		// 9.50 persisted + 0.75 this turn = 10.25 > 10
		const breaches = evaluateLimits(
			turn({ costUsd: 0.75 }),
			lifetime({ lifetimeCostUsd: 9.5 }),
			rules,
		);
		expect(breaches).toHaveLength(1);
		expect(breaches[0].rule.id).toBe("hard:maxLifetimeCostUsd");
		expect(breaches[0].value).toBeCloseTo(10.25, 10);
	});

	it("reads consecutiveZeroOutputTurns from lifetime", () => {
		const rules = buildRules({ warnConsecutiveZeroOutputTurns: 3 }).filter(
			(r) => r.metric === "consecutiveZeroOutputTurns",
		);
		expect(
			evaluateLimits(
				turn(),
				lifetime({ consecutiveZeroOutputTurns: 4 }),
				rules,
			),
		).toHaveLength(1);
		expect(
			evaluateLimits(
				turn(),
				lifetime({ consecutiveZeroOutputTurns: 2 }),
				rules,
			),
		).toHaveLength(0);
	});

	it("classifies turn-window vs lifetime metrics", () => {
		expect(isTurnMetric("llmCallCount")).toBe(true);
		expect(isTurnMetric("costUsd")).toBe(true);
		expect(isTurnMetric("lifetimeCostUsd")).toBe(false);
		expect(isTurnMetric("consecutiveZeroOutputTurns")).toBe(false);
	});
});
