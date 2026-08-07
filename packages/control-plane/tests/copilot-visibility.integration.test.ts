/**
 * Control-plane copilot visibility backend — spend cap (users.ts,
 * copilot-router.ts's checkCopilotSpendCap) and transcript queries
 * (transcript-queries.ts), against real MongoDB. No LLM calls, no daemon —
 * calls the plain functions directly, same precedent as
 * limits.integration.test.ts.
 */

import { randomUUID } from "node:crypto";
import type { Db, MongoClient } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectMongo } from "../../agent-runtime-worker/src/mongo.js";
import { checkCopilotSpendCap } from "../src/copilot-router.js";
import {
	queryLlmCall,
	queryLlmCalls,
	queryTranscript,
	queryTurns,
} from "../src/transcript-queries.js";
import { getCopilotSpendCap, setCopilotSpendCap } from "../src/users.js";

describe("copilot visibility backend", () => {
	// biome-ignore lint/style/noNonNullAssertion: required env var; vitest.setup.ts validates presence
	const MONGODB_URI = process.env.MONGODB_URI!;

	let client: MongoClient;
	let db: Db;
	const uid = `user-${randomUUID()}`;
	const missionId = `copilot-${uid}`;

	beforeEach(async () => {
		({ client, db } = await connectMongo(MONGODB_URI, "magi-test"));
	});

	afterEach(async () => {
		await db.collection("users").deleteMany({ uid });
		await db.collection("missionStats").deleteMany({ missionId });
		await db.collection("agentTurnStats").deleteMany({ missionId });
		await db.collection("conversationMessages").deleteMany({ missionId });
		await db.collection("llmCallLog").deleteMany({ missionId });
		await client.close();
	});

	describe("getCopilotSpendCap / setCopilotSpendCap", () => {
		it("is undefined until set, round-trips a value, and clears with undefined", async () => {
			expect(await getCopilotSpendCap(db, uid)).toBeUndefined();

			await setCopilotSpendCap(db, uid, 25);
			expect(await getCopilotSpendCap(db, uid)).toBe(25);

			await setCopilotSpendCap(db, uid, undefined);
			expect(await getCopilotSpendCap(db, uid)).toBeUndefined();
		});
	});

	describe("checkCopilotSpendCap", () => {
		it("allows the request when no cap is set", async () => {
			expect(await checkCopilotSpendCap(db, uid)).toBeNull();
		});

		it("allows the request when spend is under the cap", async () => {
			await setCopilotSpendCap(db, uid, 10);
			await db.collection("missionStats").insertOne({
				missionId,
				agentId: "copilot",
				lifetimeCostUsd: 4.5,
				lifetimeLlmCallCount: 3,
				lifetimeTurnCount: 1,
				consecutiveZeroOutputTurns: 0,
			});
			expect(await checkCopilotSpendCap(db, uid)).toBeNull();
		});

		it("blocks the request with a clear error once spend reaches the cap", async () => {
			await setCopilotSpendCap(db, uid, 10);
			await db.collection("missionStats").insertOne({
				missionId,
				agentId: "copilot",
				lifetimeCostUsd: 10.5,
				lifetimeLlmCallCount: 3,
				lifetimeTurnCount: 1,
				consecutiveZeroOutputTurns: 0,
			});
			const error = await checkCopilotSpendCap(db, uid);
			expect(error).not.toBeNull();
			expect(error).toContain("$10.50");
			expect(error).toContain("$10.00");
		});
	});

	describe("transcript-queries.ts against the copilot's own missionId/agentId", () => {
		const agentId = "copilot";

		beforeEach(async () => {
			await db.collection("agentTurnStats").insertOne({
				missionId,
				agentId,
				turnNumber: 1,
				startedAt: new Date(),
				completedAt: new Date(),
				costUsd: 0.5,
				llmCallCount: 2,
				peakContextTokens: 1000,
				status: "complete",
			});
			await db.collection("conversationMessages").insertOne({
				missionId,
				agentId,
				turnNumber: 1,
				callSeq: 0,
				parentToolUseId: null,
				message: { role: "assistant", content: "hi" },
			});
			await db.collection("llmCallLog").insertOne({
				missionId,
				agentId,
				turnNumber: 1,
				savedAt: new Date(),
				model: "claude-sonnet-4-6",
				usage: { inputTokens: 100, outputTokens: 20 },
				cost: { totalCostUsd: 0.5 },
				input: { toolNames: [], messages: [] },
				output: { response: { stopReason: "end_turn" } },
			});
		});

		it("queryTurns/queryTranscript/queryLlmCalls/queryLlmCall need no `missions` document to work", async () => {
			const turns = await queryTurns(db, missionId, agentId);
			expect(turns).toHaveLength(1);
			expect(turns[0].turnNumber).toBe(1);

			const transcript = await queryTranscript(db, missionId, agentId, 1);
			expect(transcript).toHaveLength(1);

			const calls = await queryLlmCalls(db, missionId, agentId, 1);
			expect(calls).toHaveLength(1);

			const detail = await queryLlmCall(db, missionId, agentId, 1, 0);
			expect(detail?.model).toBe("claude-sonnet-4-6");

			expect(await queryLlmCall(db, missionId, agentId, 1, 5)).toBeNull();
		});
	});
});
