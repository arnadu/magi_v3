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

import {
	type CallUsage,
	type LlmCallDetail,
	type LlmCallLogEntry,
	type LlmCallSummary,
	type LoggedMessage,
	type SummaryMessage,
	storedCollection,
	type TranscriptEntry,
} from "@magi/agent-config";
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
	const turns = await storedCollection(db, "agentTurnStats")
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

export async function queryTranscript(
	db: Db,
	missionId: string,
	agentId: string,
	turn: number,
): Promise<TranscriptEntry<LoggedMessage | SummaryMessage>[]> {
	const docs = await storedCollection(db, "conversationMessages")
		.find({ missionId, agentId, turnNumber: turn })
		.sort({ callSeq: 1, _id: 1 })
		.toArray();
	return docs.map((d) => ({
		callSeq: d.callSeq ?? 0,
		callId: d.callId ?? null,
		parentToolUseId: d.parentToolUseId ?? null,
		message: d.message,
	}));
}

/**
 * Flattened from the stored `LlmCallLogEntry` so the cockpit reads one
 * documented shape instead of the writer's.
 */
export function callUsageOf(c: Partial<Pick<LlmCallLogEntry, "usage">>): {
	usage: CallUsage | null;
	costUsd: number | null;
} {
	const u = c.usage;
	if (!u) return { usage: null, costUsd: null };
	return {
		usage: {
			inputTokens: u.inputTokens ?? 0,
			outputTokens: u.outputTokens ?? 0,
			cacheReadTokens: u.cacheReadTokens ?? 0,
			cacheWriteTokens: u.cacheWriteTokens ?? 0,
		},
		costUsd: u.cost?.totalCostUsd ?? null,
	};
}

export async function queryLlmCalls(
	db: Db,
	missionId: string,
	agentId: string,
	turn: number,
): Promise<LlmCallSummary<Date>[]> {
	// TQ1: the list needs counts and names, not the call bodies — message
	// roles give the count, output.stopReason marks a retained body.
	const calls = await storedCollection(db, "llmCallLog")
		.find(
			{ missionId, agentId, turnNumber: turn },
			{
				projection: {
					callId: 1,
					savedAt: 1,
					model: 1,
					isReflection: 1,
					costEstimated: 1,
					usage: 1,
					"input.toolNames": 1,
					"input.messages.role": 1,
					"output.stopReason": 1,
				},
			},
		)
		.sort({ savedAt: 1 })
		.toArray();
	return calls.map((c, i) => ({
		index: i,
		callId: c.callId ?? null,
		savedAt: c.savedAt,
		model: c.model,
		isReflection: c.isReflection ?? false,
		costEstimated: c.costEstimated ?? false,
		stopReason: c.output?.stopReason ?? null,
		...callUsageOf(c),
		toolNames: c.input?.toolNames ?? [],
		messageCount: Array.isArray(c.input?.messages)
			? c.input.messages.length
			: 0,
		hasBody: Boolean(c.output),
	}));
}

/** Returns null if no call exists at that index (caller should 404). */
export async function queryLlmCall(
	db: Db,
	missionId: string,
	agentId: string,
	turn: number,
	i: number,
): Promise<LlmCallDetail<Date, LoggedMessage> | null> {
	const c = (
		await storedCollection(db, "llmCallLog")
			.find({ missionId, agentId, turnNumber: turn })
			.sort({ savedAt: 1 })
			.skip(i)
			.limit(1)
			.toArray()
	)[0];
	if (!c) return null;
	return {
		index: i,
		callId: c.callId ?? null,
		savedAt: c.savedAt,
		model: c.model,
		isReflection: c.isReflection ?? false,
		costEstimated: c.costEstimated ?? false,
		...callUsageOf(c),
		input: c.input ?? null,
		output: c.output ?? null,
	};
}
