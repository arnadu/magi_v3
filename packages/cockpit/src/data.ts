import type { FoldedTree } from "./types";

// The cockpit is served same-origin by the control plane, so the magi_session
// cookie set by the dashboard login carries auth automatically. `/missions/:id/*`
// is proxied to that mission's monitor; `GET /objectives` returns the folded store.

export class AuthError extends Error {}

async function api<T>(path: string): Promise<T> {
	const res = await fetch(path, {
		credentials: "include",
		headers: { Accept: "application/json" },
	});
	if (res.status === 401 || res.status === 403) {
		throw new AuthError("not signed in");
	}
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
	return (await res.json()) as T;
}

export function fetchObjectives(missionId: string): Promise<FoldedTree> {
	return api<FoldedTree>(
		`/missions/${encodeURIComponent(missionId)}/objectives`,
	);
}

export interface MissionSummary {
	missionId: string;
	name: string;
}

/** The current user's missions (for the picker when no ?mission is given). */
export function fetchMissions(): Promise<MissionSummary[]> {
	return api<MissionSummary[]>("/api/missions");
}

export interface UserMessage {
	id: string;
	from: string;
	subject: string;
	body: string;
	timestamp: string;
	read: boolean;
}

/** Messages addressed to the operator for a mission (newest first). */
export function fetchMessages(missionId: string): Promise<UserMessage[]> {
	return api<UserMessage[]>(
		`/api/missions/${encodeURIComponent(missionId)}/messages`,
	);
}

/** Mark operator messages read. */
export async function markMessagesRead(
	missionId: string,
	ids: string[],
): Promise<void> {
	if (ids.length === 0) return;
	await fetch(`/api/missions/${encodeURIComponent(missionId)}/messages/read`, {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ids }),
	});
}
