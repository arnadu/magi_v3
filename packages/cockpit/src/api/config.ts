import { api, mp, request } from "./http";

// Editable, only while the mission is suspended: mission
// name/model/visionModel/timezone, per-agent name/model/active/
// disabledSkills/disabledTools/supervisor/systemPrompt, and the live mental
// map. Every other field (id, initialMentalMap post-launch — that's the
// template, inert after an agent's first run — limits, linuxUser, teamFiles,
// missionCopilotLimits) must round-trip unmodified — the PUT is a full
// replace, not a per-field patch, so omitting any of them silently clears it
// server-side. supervisor/systemPrompt were mission-copilot-only under
// ADR-0022's original decision; the ADR now gives the operator direct
// control instead. The live mental map is a separate `mentalMaps` patch, not
// part of `agents`, validated server-side against dropping a data-managed
// section (ADR-0022's "Post-ADR-0022 addendum").

export interface MissionConfigAgent {
	id: string;
	name?: string;
	role?: string;
	supervisor: string;
	systemPrompt: string;
	initialMentalMap: string;
	model?: string;
	active?: boolean;
	disabledSkills?: string[];
	disabledTools?: string[];
	[key: string]: unknown;
}

export interface MissionConfigMission {
	id: string;
	name: string;
	model?: string;
	visionModel?: string;
	timezone?: string;
	[key: string]: unknown;
}

export interface MissionConfigData {
	mission: MissionConfigMission;
	agents: MissionConfigAgent[];
	missionCopilotLimits?: unknown;
	teamFiles: Array<{ path: string; content: string }>;
	mentalMaps: Record<string, string>;
	/**
	 * The mission copilot isn't in `agents` (injected in-memory only, ADR-0016),
	 * and its systemPrompt/initialMentalMap aren't stored fields — both are
	 * synthesized fresh every session from a fixed platform template plus this
	 * mission's own name/roster. Read-only display only; nothing to save back.
	 * Its live mental map (if it has run) is under `mentalMaps["mission-copilot"]`,
	 * same as any other agent.
	 */
	missionCopilot: { systemPrompt: string; initialMentalMap: string };
}

export function fetchMissionConfig(
	missionId: string,
): Promise<MissionConfigData> {
	return api<MissionConfigData>(`/api/missions/${mp(missionId)}/config`);
}

/** Throws with the server's real error text on failure (e.g. 409 while not suspended). */
export async function saveMissionConfig(
	missionId: string,
	payload: {
		mission: MissionConfigMission;
		agents: MissionConfigAgent[];
		missionCopilotLimits: unknown;
		teamFiles: Array<{ path: string; content: string }>;
		/** agentId -> full replacement HTML, including "mission-copilot" if edited. */
		mentalMaps?: Record<string, string>;
		/** The document's updatedAt when the form was loaded; the server refuses (409) if it has moved. */
		expectedUpdatedAt?: string;
	},
): Promise<void> {
	await request(`/api/missions/${mp(missionId)}/config`, {
		method: "PUT",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
}

/** Just the fields the config editor needs to know whether editing is allowed right now. */
