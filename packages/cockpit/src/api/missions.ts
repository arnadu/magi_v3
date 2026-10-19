import type { FoldedTree } from "../types";
import { api, mp, request } from "./http";

export function fetchObjectives(missionId: string): Promise<FoldedTree> {
	return api<FoldedTree>(
		`/api/missions/${encodeURIComponent(missionId)}/objectives`,
	);
}

export type MissionStatusValue =
	| "draft"
	| "provisioning"
	| "running"
	| "suspended"
	| "destroyed"
	| "error";

export interface MissionSummary {
	missionId: string;
	name: string;
	status: MissionStatusValue;
	createdAt: string;
	errorMessage?: string;
	/** GET /api/missions returns the full stored doc (no projection) — mission.maxCostUsd rides along for free. */
	mission?: { maxCostUsd?: number | null };
}

/** The current user's missions (for the picker when no ?mission is given). */
export function fetchMissions(): Promise<MissionSummary[]> {
	return api<MissionSummary[]>("/api/missions");
}

/** Launches a mission from a template. Returns the created mission's id. */
export async function createMission(
	missionId: string,
	name: string,
	templateId: string,
): Promise<void> {
	await request("/api/missions", {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ missionId, name, teamConfig: templateId }),
	});
}

async function missionAction(missionId: string, action: string): Promise<void> {
	await request(`/api/missions/${mp(missionId)}/${action}`, {
		method: "POST",
		credentials: "include",
	});
}

export const suspendMission = (missionId: string): Promise<void> =>
	missionAction(missionId, "suspend");

export const resumeMission = (missionId: string): Promise<void> =>
	missionAction(missionId, "resume");

export async function deleteMission(missionId: string): Promise<void> {
	await request(`/api/missions/${mp(missionId)}`, {
		method: "DELETE",
		credentials: "include",
	});
}

// ── Mission-prep drafts ──────────────────────────────────────────────────────

export async function fetchMissionStatus(
	missionId: string,
): Promise<MissionStatusValue> {
	const m = await api<{ status: MissionStatusValue }>(
		`/api/missions/${mp(missionId)}`,
	);
	return m.status;
}

/**
 * Cheap staleness check for the Draft Editor's poll — a draft has no
 * machineId, so GET /:id never attempts a live Fly lookup for one, making
 * this call fast enough to poll every few seconds.
 */
export async function fetchMissionUpdatedAt(
	missionId: string,
): Promise<string> {
	const m = await api<{ updatedAt: string }>(`/api/missions/${mp(missionId)}`);
	return m.updatedAt;
}

/** The mission's display name, for the per-mission dashboard header. */
export async function fetchMissionName(missionId: string): Promise<string> {
	const m = await api<{ name: string }>(`/api/missions/${mp(missionId)}`);
	return m.name;
}

// ── Cross-mission stats — ported from index.html's Active Sessions cards ───

export interface MissionStatsEntry {
	unread: number;
	spendTotal: number;
	spendToday: number;
	spendLastHour: number;
	lastActivity: string | null;
	snippet: string | null;
}

export function fetchMissionsStats(): Promise<
	Record<string, MissionStatsEntry>
> {
	return api<Record<string, MissionStatsEntry>>("/api/missions/stats");
}

/** Skill and tool names the config editors may toggle (GET /api/catalog). */
export interface ToggleCatalog {
	platformSkills: string[];
	tierATools: string[];
}

export function fetchCatalog(): Promise<ToggleCatalog> {
	return api<ToggleCatalog>("/api/catalog");
}
