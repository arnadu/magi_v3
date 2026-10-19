import type {
	LlmCallDetail,
	LlmCallSummary,
	TranscriptEntry,
} from "../llm-call-types.js";
import { api, mp, request } from "./http";

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

export type {
	LlmCallDetail,
	LlmCallSummary,
	TranscriptEntry,
	Usage,
} from "../llm-call-types.js";

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
	await request(`/missions/${encodeURIComponent(missionId)}/upload`, {
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
