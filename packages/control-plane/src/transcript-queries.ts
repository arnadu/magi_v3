/**
 * Shared (missionId, agentId[, turnNumber])-scoped read queries against
 * agentTurnStats/conversationMessages/llmCallLog — the data behind the
 * cockpit's Transcripts tab. Used by both `missions.ts` (mission agents,
 * ownership-checked against the `missions` collection before calling these)
 * and `copilot-router.ts` (the control-plane copilot, which has no `missions`
 * document — its userId scoping happens entirely via the derived
 * `missionId = "copilot-{userId}"`, so no separate ownership check is needed
 * here). None of these functions read anything outside the three collections
 * named above — no dependency on a `missions` document exists or is assumed.
 */

import type { Db } from "mongodb";

export interface TurnSummary {
	turnNumber: number;
	startedAt: unknown;
	completedAt: unknown;
	status: string;
	llmCallCount: number;
	costUsd: number;
	peakContextTokens: number;
	toolCalls: Record<string, number>;
	toolErrors: Record<string, number>;
}

export async function queryTurns(
	db: Db,
	missionId: string,
	agentId: string,
): Promise<TurnSummary[]> {
	const turns = await db
		.collection("agentTurnStats")
		.find({ missionId, agentId })
		.sort({ turnNumber: 1 })
		.toArray();
	return turns.map((t) => ({
		turnNumber: t.turnNumber,
		startedAt: t.startedAt,
		completedAt: t.completedAt ?? null,
		status: t.status,
		llmCallCount: t.llmCallCount ?? 0,
		costUsd: t.costUsd ?? 0,
		peakContextTokens: t.peakContextTokens ?? 0,
		toolCalls: t.toolCalls ?? {},
		toolErrors: t.toolErrors ?? {},
	}));
}

export interface TranscriptEntry {
	callSeq: number;
	parentToolUseId: string | null;
	message: unknown;
}

export async function queryTranscript(
	db: Db,
	missionId: string,
	agentId: string,
	turn: number,
): Promise<TranscriptEntry[]> {
	const docs = await db
		.collection("conversationMessages")
		.find({ missionId, agentId, turnNumber: turn })
		.sort({ callSeq: 1, _id: 1 })
		.toArray();
	return docs.map((d) => ({
		callSeq: d.callSeq ?? 0,
		parentToolUseId: d.parentToolUseId ?? null,
		message: d.message,
	}));
}

export interface LlmCallSummary {
	index: number;
	savedAt: unknown;
	model: string;
	isReflection: boolean;
	costEstimated: boolean;
	stopReason: string | null;
	usage: unknown;
	cost: unknown;
	toolNames: string[];
	messageCount: number;
	hasBody: boolean;
}

export async function queryLlmCalls(
	db: Db,
	missionId: string,
	agentId: string,
	turn: number,
): Promise<LlmCallSummary[]> {
	const calls = await db
		.collection("llmCallLog")
		.find({ missionId, agentId, turnNumber: turn })
		.sort({ savedAt: 1 })
		.toArray();
	return calls.map((c, i) => ({
		index: i,
		savedAt: c.savedAt,
		model: c.model,
		isReflection: c.isReflection ?? false,
		costEstimated: c.costEstimated ?? false,
		stopReason: c.output?.response?.stopReason ?? null,
		usage: c.usage ?? null,
		cost: c.cost ?? null,
		toolNames: c.input?.toolNames ?? [],
		messageCount: Array.isArray(c.input?.messages)
			? c.input.messages.length
			: 0,
		hasBody: Boolean(c.output),
	}));
}

export interface LlmCallDetail {
	index: number;
	savedAt: unknown;
	model: string;
	isReflection: boolean;
	costEstimated: boolean;
	usage: unknown;
	cost: unknown;
	input: unknown;
	output: unknown;
}

/** Returns null if no call exists at that index (caller should 404). */
export async function queryLlmCall(
	db: Db,
	missionId: string,
	agentId: string,
	turn: number,
	i: number,
): Promise<LlmCallDetail | null> {
	const c = (
		await db
			.collection("llmCallLog")
			.find({ missionId, agentId, turnNumber: turn })
			.sort({ savedAt: 1 })
			.skip(i)
			.limit(1)
			.toArray()
	)[0];
	if (!c) return null;
	return {
		index: i,
		savedAt: c.savedAt,
		model: c.model,
		isReflection: c.isReflection ?? false,
		costEstimated: c.costEstimated ?? false,
		usage: c.usage ?? null,
		cost: c.cost ?? null,
		input: c.input ?? null,
		output: c.output ?? null,
	};
}
