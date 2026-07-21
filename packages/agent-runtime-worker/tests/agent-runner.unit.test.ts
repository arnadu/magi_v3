/**
 * ADR-0018 follow-up: unit tests for `resolveLiveLimits`, the pure function
 * behind `enforceLimits`'s live-config read. Covers the mission-copilot bug
 * found during review (its limits live in a separate top-level TeamConfig
 * field, not `agents[]`) and the "explicit clear must not fall back to a
 * stale snapshot" semantics.
 */

import type { TeamConfig } from "@magi/agent-config";
import { describe, expect, it } from "vitest";
import { resolveLiveLimits } from "../src/agent-runner.js";
import { MISSION_COPILOT_AGENT_ID } from "../src/mission-copilot.js";

function teamConfig(overrides: Partial<TeamConfig> = {}): TeamConfig {
	return {
		mission: { id: "m1", name: "Test Mission" },
		agents: [
			{
				id: "analyst",
				supervisor: "user",
				systemPrompt: "x",
				initialMentalMap: "<section></section>",
				limits: { maxLlmCallsPerTurn: 10 },
			},
			{
				id: "trader",
				supervisor: "user",
				systemPrompt: "x",
				initialMentalMap: "<section></section>",
				// no limits configured
			},
		],
		...overrides,
	} as TeamConfig;
}

describe("resolveLiveLimits", () => {
	it("falls back to the boot-time snapshot when live is null (read failed / doc missing)", () => {
		const fallback = { maxLlmCallsPerTurn: 1 };
		expect(resolveLiveLimits(null, "analyst", fallback)).toBe(fallback);
	});

	it("returns the live agent's limits when present, overriding the snapshot", () => {
		const live = teamConfig();
		const result = resolveLiveLimits(live, "analyst", {
			maxLlmCallsPerTurn: 999,
		});
		expect(result).toEqual({ maxLlmCallsPerTurn: 10 });
	});

	it("treats an agent with no live limits as genuinely having none — does NOT fall back to the stale snapshot", () => {
		// This is the "operator cleared a limit" case: the live doc was
		// successfully read, the agent exists, it just has no limits node.
		// Falling back here would silently keep enforcing a cleared limit.
		const live = teamConfig();
		const result = resolveLiveLimits(live, "trader", {
			maxLlmCallsPerTurn: 999,
		});
		expect(result).toEqual({});
	});

	it("resolves the mission copilot's limits from missionCopilotLimits, not agents[]", () => {
		const live = teamConfig({
			missionCopilotLimits: { maxCostPerTurnUsd: 5 },
		});
		const result = resolveLiveLimits(live, MISSION_COPILOT_AGENT_ID, {
			maxCostPerTurnUsd: 999,
		});
		expect(result).toEqual({ maxCostPerTurnUsd: 5 });
	});

	it("returns {} for the mission copilot when missionCopilotLimits is unset, not the stale snapshot", () => {
		const live = teamConfig(); // no missionCopilotLimits
		const result = resolveLiveLimits(live, MISSION_COPILOT_AGENT_ID, {
			maxCostPerTurnUsd: 999,
		});
		expect(result).toEqual({});
	});

	it("returns {} when the agentId isn't found in live.agents (config drift), not the stale snapshot", () => {
		const live = teamConfig();
		const result = resolveLiveLimits(live, "ghost-agent", {
			maxLlmCallsPerTurn: 999,
		});
		expect(result).toEqual({});
	});
});
