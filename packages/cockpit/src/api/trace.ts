import { api } from "./http";

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
	startedAt: string;
	completedAt: string;
	costUsd: number;
	llmCallCount: number;
	peakContextTokens: number;
	status: "running" | "complete" | "aborted";
	gitChangedFiles?: { path: string; status: string }[];
}

/**
 * Per-agent per-turn stats, for the cost-over-time chart and its turn/file/
 * anomaly markers. Only finalized turns (with a settled cost + duration) are
 * returned.
 */
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

export interface MessageEvent {
	from: string;
	to: string[];
	subject: string;
	timestamp: string;
}

/** Every mailbox message in the mission, timestamped, for the Trace markers. */
export function fetchMessageEvents(missionId: string): Promise<MessageEvent[]> {
	return api<MessageEvent[]>(
		`/missions/${encodeURIComponent(missionId)}/message-events`,
	);
}

// ── Limits panel (budget/limits vs. current consumption) ────────────────────
