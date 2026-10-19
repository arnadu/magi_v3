import { api, request } from "./http";

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
	await request(
		`/api/missions/${encodeURIComponent(missionId)}/messages/read`,
		{
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ids }),
		},
	);
}

/** Send an operator message to one or more agents (wakes them). */
export async function sendMessage(
	missionId: string,
	to: string[],
	body: string,
	subject?: string,
): Promise<void> {
	await request(
		`/api/missions/${encodeURIComponent(missionId)}/messages/send`,
		{
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ to, body, subject }),
		},
	);
}

// ── Transcript + LLM-log explorer ───────────────────────────────────────────
