import type {
	LlmCallDetail,
	LlmCallSummary,
	TranscriptEntry,
} from "../llm-call-types.js";
import type { FileNode } from "./files";
import { api, request } from "./http";
import type { TurnSummary } from "./transcripts";

// Ports index.html's copilot pane (lines ~339-360, ~1342-1607) to the cockpit.

export interface CopilotHistoryEntry {
	role: "user" | "assistant";
	body: string;
	subject: string;
	timestamp: string;
}

export function fetchCopilotHistory(): Promise<CopilotHistoryEntry[]> {
	return api<CopilotHistoryEntry[]>("/api/copilot/history");
}

export interface CopilotPendingAction {
	id: string;
	type: string;
	label: string;
	payload?: unknown;
	createdAt: string;
}

/** Cards still awaiting confirmation — persisted server-side, so a reload or a control-plane restart does not lose them. */
export async function fetchCopilotPendingActions(): Promise<
	CopilotPendingAction[]
> {
	const r = await api<{ actions: CopilotPendingAction[] }>(
		"/api/copilot/pending",
	);
	return r.actions;
}

export interface CopilotUsage {
	calls: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	costUsd: number;
}

export function fetchCopilotUsage(): Promise<CopilotUsage> {
	return api<CopilotUsage>("/api/copilot/usage");
}

export interface CopilotSettings {
	model: string;
	isDefault: boolean;
}

export function fetchCopilotSettings(): Promise<CopilotSettings> {
	return api<CopilotSettings>("/api/copilot/settings");
}

/** Throws with the server's real error text on failure (e.g. a 409 while a turn is in flight). */
export async function saveCopilotSettings(model: string | null): Promise<void> {
	await request("/api/copilot/settings", {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model }),
	});
}

/** Throws with the server's real error text on failure (e.g. a 402 naming the exact spend cap reached). */
export async function sendCopilotMessage(body: string): Promise<void> {
	const res = await request("/api/copilot/message", {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ subject: "Operator message", body }),
	});
	if (!res.ok) {
		const errBody = await res.json().catch(() => null);
		throw new Error(
			(errBody as { error?: string } | null)?.error ?? `HTTP ${res.status}`,
		);
	}
}

export async function confirmCopilotAction(
	pendingActionId: string,
): Promise<{ result?: string; error?: string }> {
	const res = await fetch("/api/copilot/confirm", {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ pendingActionId }),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) {
		return {
			error: (body as { error?: string }).error ?? `HTTP ${res.status}`,
		};
	}
	return { result: (body as { result?: string }).result };
}

export async function dismissCopilotAction(
	pendingActionId: string,
): Promise<void> {
	await request("/api/copilot/dismiss", {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ pendingActionId }),
	});
}

// ── Copilot visibility — transcripts, files, spend-cap limits ──────────────
// Same response shapes as the mission Transcripts/Files/Limits routes (reusing
// those types below), but scoped by the caller's own session — no missionId/
// agentId params, since there's exactly one copilot per user.

export function fetchCopilotTurns(): Promise<TurnSummary[]> {
	return api<TurnSummary[]>("/api/copilot/turns");
}

export function fetchCopilotTranscript(
	turn: number,
): Promise<TranscriptEntry[]> {
	return api<TranscriptEntry[]>(`/api/copilot/transcript?turn=${turn}`);
}

export function fetchCopilotLlmCalls(turn: number): Promise<LlmCallSummary[]> {
	return api<LlmCallSummary[]>(`/api/copilot/llm-calls?turn=${turn}`);
}

export function fetchCopilotLlmCall(
	turn: number,
	i: number,
): Promise<LlmCallDetail> {
	return api<LlmCallDetail>(`/api/copilot/llm-call?turn=${turn}&i=${i}`);
}

export function fetchCopilotFileNode(path: string): Promise<FileNode> {
	return api<FileNode>(`/api/copilot/files?path=${encodeURIComponent(path)}`);
}

export interface CopilotLimits {
	capUsd: number | null;
	spentUsd: number;
}

export function fetchCopilotLimits(): Promise<CopilotLimits> {
	return api<CopilotLimits>("/api/copilot/limits");
}

export async function saveCopilotLimits(capUsd: number | null): Promise<void> {
	await request("/api/copilot/limits", {
		method: "PATCH",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ capUsd }),
	});
}

// ── Scheduled wake-ups — ported from the mission-local dashboard's Schedule
// tab (agent-runtime-worker/public/app.js), which has no cockpit surface.
