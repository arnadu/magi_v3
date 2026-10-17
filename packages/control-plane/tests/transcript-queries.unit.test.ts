/**
 * Contract between the writer of `llmCallLog` / `conversationMessages`
 * (agent-runtime-worker) and the cockpit's reader (transcript-queries.ts).
 * The fixture is typed as the writer's own `LlmCallLogEntry`, so a renamed
 * stored field fails here at compile time instead of showing blanks in the
 * Transcripts tab (CK-STALE / STATS1 class).
 */

import type { LlmCallLogEntry } from "@magi/agent-runtime-worker";
import { describe, expect, it } from "vitest";
import {
	queryLlmCall,
	queryLlmCalls,
	queryTranscript,
	queryTurns,
} from "../src/transcript-queries.js";
import { fakeDb } from "./support/fake-db.js";

const entry = (over: Partial<LlmCallLogEntry>): LlmCallLogEntry => ({
	missionId: "m1",
	agentId: "a1",
	turnNumber: 3,
	isReflection: false,
	savedAt: new Date("2026-10-17T10:00:00Z"),
	model: "claude-sonnet-4-6",
	costEstimated: false,
	input: { systemPrompt: "s", messages: [], toolNames: ["Bash"] },
	output: {
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 0,
		},
		stopReason: "toolUse",
	},
	usage: {
		inputTokens: 1200,
		outputTokens: 80,
		cacheReadTokens: 900,
		cacheWriteTokens: 0,
		cost: {
			inputCostUsd: 0.003,
			outputCostUsd: 0.001,
			cacheReadCostUsd: 0.0003,
			cacheWriteCostUsd: 0,
			totalCostUsd: 0.0043,
		},
	},
	...over,
});

describe("queryLlmCalls / queryLlmCall read the writer's stored shape", () => {
	it("flattens tokens and the total cost, and passes the call id and stop reason through", async () => {
		const { db } = fakeDb({
			llmCallLog: [
				entry({ callId: "c-1" }),
				entry({
					callId: "c-2",
					savedAt: new Date("2026-10-17T10:00:05Z"),
					usage: undefined as never,
				}),
			],
		});
		const calls = await queryLlmCalls(db as never, "m1", "a1", 3);
		expect(calls).toHaveLength(2);
		expect(calls[0]).toMatchObject({
			index: 0,
			callId: "c-1",
			usage: {
				inputTokens: 1200,
				outputTokens: 80,
				cacheReadTokens: 900,
				cacheWriteTokens: 0,
			},
			costUsd: 0.0043,
			stopReason: "toolUse",
			toolNames: ["Bash"],
			hasBody: true,
		});
		expect(calls[1]).toMatchObject({ index: 1, usage: null, costUsd: null });

		const detail = await queryLlmCall(db as never, "m1", "a1", 3, 0);
		expect(detail).toMatchObject({ callId: "c-1", costUsd: 0.0043 });
		expect((detail?.output as { stopReason: string }).stopReason).toBe(
			"toolUse",
		);
		expect(await queryLlmCall(db as never, "m1", "a1", 3, 5)).toBeNull();
	});
});

describe("queryTranscript", () => {
	it("returns the call id of an assistant message and null where none was stored", async () => {
		const { db } = fakeDb({
			conversationMessages: [
				{
					missionId: "m1",
					agentId: "a1",
					turnNumber: 3,
					callSeq: -1,
					message: { role: "user", content: "task" },
				},
				{
					missionId: "m1",
					agentId: "a1",
					turnNumber: 3,
					callSeq: 0,
					callId: "c-1",
					message: { role: "assistant", content: [] },
				},
			],
		});
		const t = await queryTranscript(db as never, "m1", "a1", 3);
		expect(t.map((e) => e.callId)).toEqual([null, "c-1"]);
	});
});

describe("transcript queries on sparse, older documents", () => {
	it("queryTurns fills every missing counter with a neutral default", async () => {
		const { db } = fakeDb({
			agentTurnStats: [
				{
					missionId: "m1",
					agentId: "a1",
					turnNumber: 2,
					status: "running",
					startedAt: new Date(0),
				},
				{
					missionId: "m1",
					agentId: "a1",
					turnNumber: 1,
					status: "complete",
					startedAt: new Date(0),
					completedAt: new Date(1),
					llmCallCount: 3,
					costUsd: 0.5,
					peakContextTokens: 9,
					toolCalls: { Bash: 1 },
					toolErrors: { Bash: 1 },
				},
			],
		});
		const turns = await queryTurns(db as never, "m1", "a1");
		expect(turns.map((t) => t.turnNumber)).toEqual([1, 2]);
		expect(turns[1]).toMatchObject({
			completedAt: null,
			llmCallCount: 0,
			costUsd: 0,
			peakContextTokens: 0,
			toolCalls: {},
			toolErrors: {},
		});
		expect(turns[0]).toMatchObject({ llmCallCount: 3, toolCalls: { Bash: 1 } });
	});

	it("queryTranscript defaults callSeq and parentToolUseId", async () => {
		const { db } = fakeDb({
			conversationMessages: [
				{
					missionId: "m1",
					agentId: "a1",
					turnNumber: 1,
					message: { role: "user" },
				},
				{
					missionId: "m1",
					agentId: "a1",
					turnNumber: 1,
					callSeq: 0,
					parentToolUseId: "tu-1",
					message: { role: "assistant" },
				},
			],
		});
		const t = await queryTranscript(db as never, "m1", "a1", 1);
		expect(t[0]).toMatchObject({
			callSeq: 0,
			callId: null,
			parentToolUseId: null,
		});
		expect(t[1]).toMatchObject({ parentToolUseId: "tu-1" });
	});

	it("a call with no body, no flags and partial usage still summarises", async () => {
		const { db } = fakeDb({
			llmCallLog: [
				{
					missionId: "m1",
					agentId: "a1",
					turnNumber: 3,
					savedAt: new Date(0),
					model: "m",
					usage: { inputTokens: 5 },
				},
			],
		});
		const [c] = await queryLlmCalls(db as never, "m1", "a1", 3);
		expect(c).toMatchObject({
			callId: null,
			isReflection: false,
			costEstimated: false,
			stopReason: null,
			usage: {
				inputTokens: 5,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
			costUsd: null,
			toolNames: [],
			messageCount: 0,
			hasBody: false,
		});
		const d = await queryLlmCall(db as never, "m1", "a1", 3, 0);
		expect(d).toMatchObject({ input: null, output: null, isReflection: false });
	});
});
