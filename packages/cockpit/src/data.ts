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

export interface ConvMessage {
	id: string;
	from: string;
	to: string[];
	subject: string;
	body: string;
	timestamp: string;
	read: boolean;
}

/** Every mailbox message the operator is part of (sender or recipient). */
export function fetchConversations(missionId: string): Promise<ConvMessage[]> {
	return api<ConvMessage[]>(
		`/api/missions/${encodeURIComponent(missionId)}/conversations`,
	);
}

export interface Agent {
	id: string;
	name: string;
}

/** The mission's agent roster (for the compose recipient chips). */
export function fetchAgents(missionId: string): Promise<Agent[]> {
	return api<Agent[]>(`/api/missions/${encodeURIComponent(missionId)}/agents`);
}

/** Mark operator-addressed messages read. */
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

/** Send an operator message to one or more agents (wakes them). */
export async function sendMessage(
	missionId: string,
	to: string[],
	body: string,
	subject?: string,
): Promise<void> {
	await fetch(`/api/missions/${encodeURIComponent(missionId)}/messages/send`, {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ to, body, subject }),
	});
}

function fileToBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result as string;
			resolve(result.slice(result.indexOf(",") + 1)); // strip the data: prefix
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

/**
 * Attach a file to a message to one agent. Routes through the mission monitor's
 * upload pipeline (proxied): the file is saved, processed into an artifact, and
 * a mailbox message to the agent points at the processed content.
 */
export async function uploadAttachment(
	missionId: string,
	agentId: string,
	file: File,
	body: string,
): Promise<void> {
	const contentBase64 = await fileToBase64(file);
	await fetch(`/missions/${encodeURIComponent(missionId)}/upload`, {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			filename: file.name,
			agentId,
			contentBase64,
			mimeType: file.type || undefined,
			subject: "Operator attachment",
			body,
		}),
	});
}
