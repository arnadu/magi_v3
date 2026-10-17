import { afterEach, describe, expect, it } from "vitest";
import { parseTeamConfig, parseTeamConfigYaml } from "../src/loader.js";

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

describe("parseTeamConfigYaml — mission.memoryMb/cpus (issue #25)", () => {
	it("accepts a valid memoryMb/cpus pair", () => {
		const config = parseTeamConfigYaml(
			baseYaml("lead").replace(
				"name: Test Mission",
				"name: Test Mission\n  memoryMb: 2048\n  cpus: 2",
			),
		);
		expect(config.mission.memoryMb).toBe(2048);
		expect(config.mission.cpus).toBe(2);
	});

	it("is optional — omitting it leaves memoryMb/cpus undefined", () => {
		const config = parseTeamConfigYaml(baseYaml("lead"));
		expect(config.mission.memoryMb).toBeUndefined();
		expect(config.mission.cpus).toBeUndefined();
	});

	it("rejects memoryMb above the 4096 cap", () => {
		const yaml = baseYaml("lead").replace(
			"name: Test Mission",
			"name: Test Mission\n  memoryMb: 8192",
		);
		expect(() => parseTeamConfigYaml(yaml)).toThrow();
	});

	it("rejects a non-integer memoryMb", () => {
		const yaml = baseYaml("lead").replace(
			"name: Test Mission",
			"name: Test Mission\n  memoryMb: 512.5",
		);
		expect(() => parseTeamConfigYaml(yaml)).toThrow();
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

/**
 * ENV1 (2026-10-15 audit) — `parseTeamConfig` is the shared validator for
 * every trust level: tenant-supplied inline config (`POST /api/missions`),
 * agent/LLM-authored tool payloads (`SaveMissionConfig`, `EditDraftConfig`),
 * AND operator-authored on-disk YAML. It must never read process.env on
 * behalf of a caller who isn't the operator — a `${VAR}` string in
 * tenant-supplied config let any signed-in user retrieve any server
 * environment variable (CONTROL_API_KEY, MONGODB_URI, ...) back in the
 * API response. No shipped template ever used this feature (grep of
 * config/teams/*.yaml is empty), so the fix is to remove it, not gate it.
 */
describe("parseTeamConfig — no environment variable expansion (ENV1)", () => {
	const SECRET_VAR = "MAGI_TEST_ENV1_SECRET";

	afterEach(() => {
		delete process.env[SECRET_VAR];
	});

	function configWith(systemPrompt: string) {
		return {
			mission: { id: "test-mission", name: "Test Mission" },
			agents: [
				{
					id: "lead",
					supervisor: "user",
					systemPrompt,
					initialMentalMap: '<section id="tasks"></section>',
				},
			],
		};
	}

	it("passes a dollar-brace variable reference through literally even when the variable is set", () => {
		process.env[SECRET_VAR] = "s3cr3t-value";
		const config = parseTeamConfig(configWith(`key=\${${SECRET_VAR}}`));
		expect(config.agents[0].systemPrompt).toBe(`key=\${${SECRET_VAR}}`);
		expect(config.agents[0].systemPrompt).not.toContain("s3cr3t-value");
	});

	it("does not throw when the referenced variable is unset (no existence oracle)", () => {
		expect(SECRET_VAR in process.env).toBe(false);
		const config = parseTeamConfig(configWith(`key=\${${SECRET_VAR}}`));
		expect(config.agents[0].systemPrompt).toBe(`key=\${${SECRET_VAR}}`);
	});

	it("leaves a dollar-brace variable reference literal through the YAML path too", () => {
		process.env[SECRET_VAR] = "s3cr3t-value";
		const yaml = `
mission:
  id: test-mission
  name: Test Mission
agents:
  - id: lead
    supervisor: user
    systemPrompt: "key=\${${SECRET_VAR}}"
    initialMentalMap: <section id="tasks"></section>
`;
		const config = parseTeamConfigYaml(yaml);
		expect(config.agents[0].systemPrompt).toBe(`key=\${${SECRET_VAR}}`);
	});
});

describe("parseTeamConfig — team-level integrity (LU1/RID1/CFG1)", () => {
	const agent = (id: string, extra: Record<string, unknown> = {}) => ({
		id,
		supervisor: "user",
		systemPrompt: "x",
		initialMentalMap: '<section id="tasks"></section>',
		...extra,
	});
	const team = (agents: unknown[]) => ({
		mission: { id: "t", name: "T" },
		agents,
	});

	it("rejects duplicate agent ids", () => {
		expect(() => parseTeamConfig(team([agent("lead"), agent("lead")]))).toThrow(
			/duplicate agent id "lead"/,
		);
	});

	it("rejects two agents sharing an OS user, explicitly or via id", () => {
		expect(() =>
			parseTeamConfig(
				team([
					agent("a", { linuxUser: "magi-w1" }),
					agent("b", { linuxUser: "magi-w1" }),
				]),
			),
		).toThrow(/share the OS user "magi-w1"/);
		expect(() =>
			parseTeamConfig(team([agent("a"), agent("b", { linuxUser: "a" })])),
		).toThrow(/share the OS user "a"/);
	});

	it("rejects reserved ids and ids the OS user helper would refuse", () => {
		for (const id of ["user", "system", "scheduler", "mission-copilot"]) {
			expect(() => parseTeamConfig(team([agent(id)])), id).toThrow(/reserved/);
		}
		expect(() => parseTeamConfig(team([agent("data_bot")]))).toThrow(
			/lowercase slug/,
		);
		expect(() => parseTeamConfig(team([agent("_x")]))).toThrow(
			/lowercase slug/,
		);
		expect(() => parseTeamConfig(team([agent("copilot")]))).not.toThrow();
	});

	it('rejects a supervisor that is neither "user" nor a teammate', () => {
		expect(() =>
			parseTeamConfig(team([agent("a", { supervisor: "ghost" })])),
		).toThrow(/supervisor "ghost"/);
		expect(() =>
			parseTeamConfig(team([agent("a"), agent("b", { supervisor: "a" })])),
		).not.toThrow();
	});

	it("caps the roster and the prompt sizes", () => {
		const many = Array.from({ length: 26 }, (_, i) => agent(`a${i}`));
		expect(() => parseTeamConfig(team(many))).toThrow(/agents/);
		expect(() =>
			parseTeamConfig(
				team([agent("a", { systemPrompt: "x".repeat(200_001) })]),
			),
		).toThrow(/systemPrompt/);
	});
});
