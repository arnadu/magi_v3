import {
	type AgentConfig,
	type Limits,
	parseTeamConfig,
	type TeamConfig,
} from "./loader.js";

/** A partial edit to a mission's structured config, as the copilots send it. */
export interface TeamConfigPatch {
	/** Shallow-merged into the current mission; its id always stays the mission's own. */
	mission?: Partial<TeamConfig["mission"]>;
	/** Upserted by id: an existing id is replaced, a new one appended; nothing is removed. */
	agents?: AgentConfig[];
	/** Replaces the current value wholesale. */
	missionCopilotLimits?: Limits;
}

/**
 * Apply a patch to the stored config and validate the result as a whole.
 * Throws the schema's error when the result is invalid. The schema rejects
 * the reserved "mission-copilot" id, so a copilot cannot write itself into
 * the authored roster.
 */
export function applyTeamConfigPatch(
	current: {
		mission: TeamConfig["mission"];
		agents: AgentConfig[];
		missionCopilotLimits?: Limits;
	},
	missionId: string,
	patch: TeamConfigPatch,
): TeamConfig {
	const agents = patch.agents
		? [
				...current.agents.filter(
					(a) => !patch.agents?.some((p) => p.id === a.id),
				),
				...patch.agents,
			]
		: current.agents;
	return parseTeamConfig({
		mission: { ...current.mission, ...patch.mission, id: missionId },
		agents,
		missionCopilotLimits:
			patch.missionCopilotLimits ?? current.missionCopilotLimits,
	});
}
