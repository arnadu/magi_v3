import type { MissionConfigAgent, MissionConfigMission } from "./config";
import { mp, request } from "./http";

// A draft is a MissionDoc like any other (status: "draft", no machine yet) —
// see docs/adr/0021 and the PUT /:id/draft route comment in missions.ts for
// why draft saves skip parseTeamConfig (a blank/in-progress roster would
// always fail it) while GET /:id/config, reused unchanged below, already
// works for a draft since it only requires mission.mission/agents to exist.

/** Creates a draft mission — cloned from a template, or blank if templateId is omitted. */
export async function createDraft(
	missionId: string,
	name: string,
	templateId?: string,
): Promise<void> {
	await request("/api/missions/draft", {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ missionId, name, teamConfig: templateId }),
	});
}

/** Full-replace save of a draft's config — permissive, no validation (see PUT /:id/draft). */
export async function saveDraftConfig(
	missionId: string,
	payload: {
		mission: MissionConfigMission;
		agents: MissionConfigAgent[];
		missionCopilotLimits?: unknown;
		teamFiles: Array<{ path: string; content: string }>;
	},
): Promise<void> {
	await request(`/api/missions/${mp(missionId)}/draft`, {
		method: "PUT",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
}

/**
 * Validates a draft's stored config (full TeamConfig rules) and provisions it.
 * Throws with the server's real error text on failure — e.g. a 400 naming the
 * exact missing field, surfaced verbatim in the Draft Editor's error banner.
 */
export async function launchDraft(missionId: string): Promise<void> {
	await request(`/api/missions/${mp(missionId)}/launch`, {
		method: "POST",
		credentials: "include",
	});
}

// ── Templates (read-only, disk-only — ADR-0021/0022) ────────────────────────
