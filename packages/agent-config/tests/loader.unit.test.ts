import { describe, expect, it } from "vitest";
import { parseTeamConfigYaml } from "../src/loader.js";

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

describe("parseTeamConfigYaml — reserved mission-copilot id", () => {
	it("rejects an authored agent with id 'mission-copilot'", () => {
		expect(() => parseTeamConfigYaml(baseYaml("mission-copilot"))).toThrow(
			/reserved/i,
		);
	});

	it("accepts an authored agent with any other id", () => {
		const config = parseTeamConfigYaml(baseYaml("lead"));
		expect(config.agents[0].id).toBe("lead");
	});

	it("accepts an authored agent with id 'copilot' (the control-plane copilot's own identity, not reserved by this check)", () => {
		const config = parseTeamConfigYaml(baseYaml("copilot"));
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
		expect(() => parseTeamConfigYaml(yaml)).toThrow(/reserved/i);
	});
});

describe("parseTeamConfigYaml — mission.timezone", () => {
	it("accepts a valid IANA timezone", () => {
		const config = parseTeamConfigYaml(
			baseYaml("lead").replace(
				"name: Test Mission",
				"name: Test Mission\n  timezone: America/New_York",
			),
		);
		expect(config.mission.timezone).toBe("America/New_York");
	});

	it("is optional — omitting it leaves timezone undefined", () => {
		const config = parseTeamConfigYaml(baseYaml("lead"));
		expect(config.mission.timezone).toBeUndefined();
	});

	it("rejects an invalid IANA timezone name with a clear error", () => {
		const yaml = baseYaml("lead").replace(
			"name: Test Mission",
			"name: Test Mission\n  timezone: Not/A_Real_Zone",
		);
		expect(() => parseTeamConfigYaml(yaml)).toThrow(/valid IANA timezone/i);
	});
});

describe("parseTeamConfigYaml — agent name/role defaulting (ADR-0021)", () => {
	it("defaults name and role to id when both are omitted", () => {
		const config = parseTeamConfigYaml(baseYaml("lead"));
		expect(config.agents[0].name).toBe("lead");
		expect(config.agents[0].role).toBe("lead");
	});

	it("keeps an explicit name/role when provided", () => {
		const yaml = `
mission:
  id: test-mission
  name: Test Mission
agents:
  - id: lead
    name: "Lead"
    role: lead-agent
    supervisor: user
    systemPrompt: You are a helpful agent.
    initialMentalMap: <section id="tasks"></section>
`;
		const config = parseTeamConfigYaml(yaml);
		expect(config.agents[0].name).toBe("Lead");
		expect(config.agents[0].role).toBe("lead-agent");
	});
});
