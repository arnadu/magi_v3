import { describe, expect, it } from "vitest";
import { parseTeamConfig } from "../src/loader.js";

/**
 * Reserved "mission-copilot" agent id (ADR-0016) — the daemon injects the
 * mission copilot in code, never from YAML. Authored config must never be
 * able to claim that id, since elevated-tool grant is keyed on it. Not
 * "copilot" — that id is the control-plane copilot's own bootstrap identity
 * (config/teams/copilot.yaml) and is unrestricted here; the mission-copilot
 * id was deliberately chosen to avoid colliding with it (see the cockpit's
 * hardcoded COPILOT_ID pseudo-agent, packages/cockpit/src/data.ts).
 */

const baseYaml = (id: string) => `
mission:
  id: test-mission
  name: Test Mission
agents:
  - id: ${id}
    supervisor: user
    systemPrompt: You are a helpful agent.
    initialMentalMap: <section id="tasks"></section>
`;

describe("parseTeamConfig — reserved mission-copilot id", () => {
	it("rejects an authored agent with id 'mission-copilot'", () => {
		expect(() => parseTeamConfig(baseYaml("mission-copilot"))).toThrow(
			/reserved/i,
		);
	});

	it("accepts an authored agent with any other id", () => {
		const config = parseTeamConfig(baseYaml("lead"));
		expect(config.agents[0].id).toBe("lead");
	});

	it("accepts an authored agent with id 'copilot' (the control-plane copilot's own identity, not reserved by this check)", () => {
		const config = parseTeamConfig(baseYaml("copilot"));
		expect(config.agents[0].id).toBe("copilot");
	});

	it("rejects 'mission-copilot' even alongside other valid agents", () => {
		const yaml = `
mission:
  id: test-mission
  name: Test Mission
agents:
  - id: lead
    supervisor: user
    systemPrompt: You are a helpful agent.
    initialMentalMap: <section id="tasks"></section>
  - id: mission-copilot
    supervisor: user
    systemPrompt: You are a helpful agent.
    initialMentalMap: <section id="tasks"></section>
`;
		expect(() => parseTeamConfig(yaml)).toThrow(/reserved/i);
	});
});

describe("parseTeamConfig — mission.timezone", () => {
	it("accepts a valid IANA timezone", () => {
		const config = parseTeamConfig(
			baseYaml("lead").replace(
				"name: Test Mission",
				"name: Test Mission\n  timezone: America/New_York",
			),
		);
		expect(config.mission.timezone).toBe("America/New_York");
	});

	it("is optional — omitting it leaves timezone undefined", () => {
		const config = parseTeamConfig(baseYaml("lead"));
		expect(config.mission.timezone).toBeUndefined();
	});

	it("rejects an invalid IANA timezone name with a clear error", () => {
		const yaml = baseYaml("lead").replace(
			"name: Test Mission",
			"name: Test Mission\n  timezone: Not/A_Real_Zone",
		);
		expect(() => parseTeamConfig(yaml)).toThrow(/valid IANA timezone/i);
	});
});
