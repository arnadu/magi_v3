import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { AgentConfig, TeamConfig } from "./types.js";

/**
 * Parse a team config YAML string into a typed TeamConfig.
 * Throws with a descriptive message on validation failure.
 */
export function parseTeamConfig(yamlContent: string): TeamConfig {
	let raw: unknown;
	try {
		raw = parse(yamlContent);
	} catch (e) {
		throw new Error(`Team config YAML parse error: ${(e as Error).message}`);
	}

	if (typeof raw !== "object" || raw === null) {
		throw new Error("Team config must be a YAML object");
	}

	const obj = raw as Record<string, unknown>;

	// Validate mission
	if (typeof obj.mission !== "object" || obj.mission === null) {
		throw new Error("Team config must have a 'mission' object");
	}
	const mission = obj.mission as Record<string, unknown>;
	if (typeof mission.id !== "string" || !mission.id) {
		throw new Error("mission.id is required");
	}
	if (typeof mission.name !== "string" || !mission.name) {
		throw new Error("mission.name is required");
	}

	// Validate agents
	if (!Array.isArray(obj.agents) || obj.agents.length === 0) {
		throw new Error("Team config must have at least one agent");
	}

	const agents: AgentConfig[] = obj.agents.map(
		(a: unknown, i: number): AgentConfig => {
			if (typeof a !== "object" || a === null) {
				throw new Error(`agents[${i}] must be an object`);
			}
			const agent = a as Record<string, unknown>;
			for (const field of ["id", "name", "role", "mission", "supervisor"]) {
				if (typeof agent[field] !== "string" || !agent[field]) {
					throw new Error(`agents[${i}].${field} is required`);
				}
			}
			return {
				id: agent.id as string,
				name: agent.name as string,
				role: agent.role as string,
				mission: (agent.mission as string).trim(),
				supervisor: agent.supervisor as string,
			};
		},
	);

	return {
		mission: { id: mission.id as string, name: mission.name as string },
		agents,
	};
}

/**
 * Load and parse a team config from a YAML file path.
 */
export function loadTeamConfig(filePath: string): TeamConfig {
	const content = readFileSync(filePath, "utf-8");
	return parseTeamConfig(content);
}
