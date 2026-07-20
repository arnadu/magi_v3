import { describe, expect, it } from "vitest";
import { parseTeamConfig } from "../src/loader.js";
import { patchAgentLimits, patchMissionCap } from "../src/yaml-patch.js";

const baseYaml = `
# a comment that must survive every patch
mission:
  id: test-mission
  name: Test Mission
agents:
  - id: analyst
    supervisor: user
    systemPrompt: You are a helpful agent.
    initialMentalMap: <section id="tasks"></section>
  - id: trader
    supervisor: user
    systemPrompt: You are a helpful agent.
    initialMentalMap: <section id="tasks"></section>
    limits:
      maxLlmCallsPerTurn: 10
`;

describe("patchAgentLimits", () => {
	it("sets a limits block on an agent that has none", () => {
		const out = patchAgentLimits(baseYaml, "analyst", {
			maxCostPerTurnUsd: 1.5,
			warnToolErrorsPerTurn: 5,
		});
		const config = parseTeamConfig(out);
		const analyst = config.agents.find((a) => a.id === "analyst");
		expect(analyst?.limits).toEqual({
			maxCostPerTurnUsd: 1.5,
			warnToolErrorsPerTurn: 5,
		});
	});

	it("overwrites an existing limits block, leaving sibling agents and comments untouched", () => {
		const out = patchAgentLimits(baseYaml, "trader", {
			maxLlmCallsPerTurn: 99,
		});
		expect(out).toContain("# a comment that must survive every patch");
		const config = parseTeamConfig(out);
		const trader = config.agents.find((a) => a.id === "trader");
		expect(trader?.limits).toEqual({ maxLlmCallsPerTurn: 99 });
		const analyst = config.agents.find((a) => a.id === "analyst");
		expect(analyst?.limits).toBeUndefined();
	});

	it("removes a limits block cleanly when passed null", () => {
		const out = patchAgentLimits(baseYaml, "trader", null);
		const config = parseTeamConfig(out);
		const trader = config.agents.find((a) => a.id === "trader");
		expect(trader?.limits).toBeUndefined();
	});

	it("throws on an unknown agentId", () => {
		expect(() => patchAgentLimits(baseYaml, "nonexistent", {})).toThrow(
			/not found/,
		);
	});

	it("writes to the top-level missionCopilotLimits field, not into agents[], for the reserved mission-copilot id", () => {
		const out = patchAgentLimits(baseYaml, "mission-copilot", {
			maxLifetimeCostUsd: 25,
		});
		const config = parseTeamConfig(out);
		expect(config.missionCopilotLimits).toEqual({ maxLifetimeCostUsd: 25 });
		// Confirm it did NOT get appended into agents[] (which parseTeamConfig
		// would in fact reject outright, since "mission-copilot" is a reserved
		// agent id — the real regression this test guards against).
		expect(config.agents.some((a) => a.id === "mission-copilot")).toBe(false);
	});

	it("clears missionCopilotLimits when passed null", () => {
		const withLimits = patchAgentLimits(baseYaml, "mission-copilot", {
			maxLifetimeCostUsd: 25,
		});
		const cleared = patchAgentLimits(withLimits, "mission-copilot", null);
		const config = parseTeamConfig(cleared);
		expect(config.missionCopilotLimits).toBeUndefined();
	});

	it("round-tripped output always still passes parseTeamConfig", () => {
		const out = patchAgentLimits(baseYaml, "analyst", {
			maxLlmCallsPerTurn: 5,
			maxCostPerTurnUsd: 0.5,
			maxLifetimeCostUsd: 10,
			warnLlmCallsPerTurn: 3,
			warnPeakContextTokens: 1000,
			warnToolErrorsPerTurn: 2,
			warnConsecutiveZeroOutputTurns: 1,
		});
		expect(() => parseTeamConfig(out)).not.toThrow();
	});
});

describe("patchMissionCap", () => {
	it("sets mission.maxCostUsd", () => {
		const out = patchMissionCap(baseYaml, 50);
		const config = parseTeamConfig(out);
		expect(config.mission.maxCostUsd).toBe(50);
	});

	it("clears mission.maxCostUsd when passed null", () => {
		const withCap = patchMissionCap(baseYaml, 50);
		const cleared = patchMissionCap(withCap, null);
		const config = parseTeamConfig(cleared);
		expect(config.mission.maxCostUsd).toBeUndefined();
	});

	it("leaves the rest of the document untouched", () => {
		const out = patchMissionCap(baseYaml, 50);
		expect(out).toContain("# a comment that must survive every patch");
		const config = parseTeamConfig(out);
		expect(config.agents).toHaveLength(2);
		expect(config.agents.find((a) => a.id === "trader")?.limits).toEqual({
			maxLlmCallsPerTurn: 10,
		});
	});
});
