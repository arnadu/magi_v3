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

/** The user's copilot — a cross-mission assistant, addressable from any cockpit. */
export const COPILOT_ID = "copilot";

/**
 * The copilot conversation (its own mailbox at missionId `copilot-{uid}`), mapped
 * into the same thread shape as mission messages. read is always true — the
 * /history endpoint does not expose readBy.
 */
export async function fetchCopilotHistory(): Promise<ConvMessage[]> {
	const raw = await api<
		{ role: string; body: string; subject: string; timestamp: string }[]
	>("/api/copilot/history");
	return raw.map((m, i) => ({
		id: `cp-${i}-${m.timestamp}`,
		from: m.role === "user" ? "user" : COPILOT_ID,
		to: m.role === "user" ? [COPILOT_ID] : ["user"],
		subject: m.subject ?? "",
		body: m.body,
		timestamp: m.timestamp,
		read: true,
	}));
}

/** Send a message to the copilot (starts its daemon if idle). */
export async function sendToCopilot(body: string): Promise<void> {
	await fetch("/api/copilot/message", {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ body }),
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

// ── Transcript + LLM-log explorer ───────────────────────────────────────────

export interface TurnSummary {
	turnNumber: number;
	startedAt: string;
	completedAt: string | null;
	status: string;
	llmCallCount: number;
	costUsd: number;
	peakContextTokens: number;
	toolCalls: Record<string, number>;
	toolErrors: Record<string, number>;
}

/** A pi-ai message, rendered defensively (shape varies by role/provider). */
export interface RawMessage {
	role: string;
	content?: unknown;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	stopReason?: string;
	[k: string]: unknown;
}

export interface TranscriptEntry {
	callSeq: number;
	parentToolUseId: string | null;
	message: RawMessage;
}

export interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface LlmCallSummary {
	index: number;
	savedAt: string;
	model: string;
	isReflection: boolean;
	costEstimated: boolean;
	stopReason: string | null;
	usage: Usage | null;
	cost: { totalUsd?: number } | null;
	toolNames: string[];
	messageCount: number;
	hasBody: boolean;
}

export interface LlmCallDetail {
	index: number;
	savedAt: string;
	model: string;
	isReflection: boolean;
	costEstimated: boolean;
	usage: Usage | null;
	cost: { totalUsd?: number } | null;
	input: {
		systemPrompt: string;
		messages: RawMessage[];
		toolNames: string[];
	} | null;
	output: { response: RawMessage } | null;
}

const mp = (id: string) => encodeURIComponent(id);

export function fetchTurns(
	missionId: string,
	agentId: string,
): Promise<TurnSummary[]> {
	return api<TurnSummary[]>(
		`/api/missions/${mp(missionId)}/turns?agent=${mp(agentId)}`,
	);
}

export function fetchTranscript(
	missionId: string,
	agentId: string,
	turn: number,
): Promise<TranscriptEntry[]> {
	return api<TranscriptEntry[]>(
		`/api/missions/${mp(missionId)}/transcript?agent=${mp(agentId)}&turn=${turn}`,
	);
}

export function fetchLlmCalls(
	missionId: string,
	agentId: string,
	turn: number,
): Promise<LlmCallSummary[]> {
	return api<LlmCallSummary[]>(
		`/api/missions/${mp(missionId)}/llm-calls?agent=${mp(agentId)}&turn=${turn}`,
	);
}

export function fetchLlmCall(
	missionId: string,
	agentId: string,
	turn: number,
	i: number,
): Promise<LlmCallDetail> {
	return api<LlmCallDetail>(
		`/api/missions/${mp(missionId)}/llm-call?agent=${mp(agentId)}&turn=${turn}&i=${i}`,
	);
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
 * Attach a file to a message to one or more agents. Routes through the mission
 * monitor's upload pipeline (proxied): the file is saved and processed into an
 * artifact ONCE, and a single mailbox message to all recipients points at it.
 */
export async function uploadAttachment(
	missionId: string,
	to: string[],
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
			agentIds: to,
			contentBase64,
			mimeType: file.type || undefined,
			subject: "Operator attachment",
			body,
		}),
	});
}

// ── Files panel (workspace browser) ─────────────────────────────────────────

export interface DirEntry {
	name: string;
	type: "dir" | "file";
	size?: number;
	modified?: string;
}

export type FileNode =
	| { type: "dir"; path: string; entries: DirEntry[] }
	| {
			type: "file";
			name: string;
			encoding: "text" | "base64" | "binary";
			mimeType?: string;
			content?: string;
			truncated?: boolean;
	  };

/** Browse a directory or read a file from the mission's shared workspace. */
export function fetchFileNode(
	missionId: string,
	path: string,
): Promise<FileNode> {
	return api<FileNode>(
		`/missions/${encodeURIComponent(missionId)}/files/shared?path=${encodeURIComponent(path)}`,
	);
}

export interface FileHistoryEntry {
	commit: string;
	timestamp: string;
	agentId: string | null;
	turnNumber: number | null;
}

/** Git provenance for a file — most recent commit first. */
export function fetchFileHistory(
	missionId: string,
	path: string,
): Promise<FileHistoryEntry[]> {
	return api<FileHistoryEntry[]>(
		`/missions/${encodeURIComponent(missionId)}/files/history?path=${encodeURIComponent(path)}`,
	);
}

/** Direct-download URL (file, or a folder as a zip) — for a plain <a href>. */
export function fileDownloadUrl(missionId: string, path: string): string {
	return `/missions/${encodeURIComponent(missionId)}/download?path=${encodeURIComponent(path)}`;
}

// ── Trace panel (mission-wide cost + interaction overview) ─────────────────

export interface AgentMissionStats {
	agentId: string;
	lifetimeCostUsd: number;
	lifetimeLlmCallCount: number;
	lifetimeTurnCount: number;
}

/** Lifetime cost/calls/turns per agent for the whole mission. */
export function fetchMissionStats(
	missionId: string,
): Promise<AgentMissionStats[]> {
	return api<AgentMissionStats[]>(
		`/missions/${encodeURIComponent(missionId)}/mission-stats`,
	);
}

export interface TurnCost {
	agentId: string;
	turnNumber: number;
	completedAt: string;
	costUsd: number;
}

/** Per-agent per-turn cost, for the cumulative cost-over-time chart. */
export function fetchCostSeries(missionId: string): Promise<TurnCost[]> {
	return api<TurnCost[]>(
		`/missions/${encodeURIComponent(missionId)}/cost-series`,
	);
}

export interface Interaction {
	from: string;
	to: string;
	count: number;
}

/** Message counts between every pair of senders/recipients in the mailbox. */
export function fetchInteractions(missionId: string): Promise<Interaction[]> {
	return api<Interaction[]>(
		`/missions/${encodeURIComponent(missionId)}/interactions`,
	);
}
