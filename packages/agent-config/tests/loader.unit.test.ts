import { describe, expect, it } from "vitest";
import { parseTeamConfig } from "../src/loader.js";

/**
 * Reserved "copilot" agent id (ADR-0016) — the daemon injects the mission
 * copilot in code, never from YAML. Authored config must never be able to
 * claim that id, since elevated-tool grant is keyed on it.
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

describe("parseTeamConfig — reserved copilot id", () => {
	it("rejects an authored agent with id 'copilot'", () => {
		expect(() => parseTeamConfig(baseYaml("copilot"))).toThrow(/reserved/i);
	});

	it("accepts an authored agent with any other id", () => {
		const config = parseTeamConfig(baseYaml("lead"));
		expect(config.agents[0].id).toBe("lead");
	});

	it("allows id 'copilot' when allowReservedCopilotId is explicitly set (control-plane copilot's own bootstrap config)", () => {
		const config = parseTeamConfig(baseYaml("copilot"), {
			allowReservedCopilotId: true,
		});
		expect(config.agents[0].id).toBe("copilot");
	});

	it("rejects 'copilot' even alongside other valid agents", () => {
		const yaml = `
mission:
  id: test-mission
  name: Test Mission
agents:
  - id: lead
    supervisor: user
    systemPrompt: You are a helpful agent.
    initialMentalMap: <section id="tasks"></section>
  - id: copilot
    supervisor: user
    systemPrompt: You are a helpful agent.
    initialMentalMap: <section id="tasks"></section>
`;
		expect(() => parseTeamConfig(yaml)).toThrow(/reserved/i);
	});
});
