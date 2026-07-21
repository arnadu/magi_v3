/**
 * Sprint 24 — Integration Test: StatsCollector against a real mission.
 *
 * Runs one real agent turn (the single-agent hello-world team) with BOTH the
 * llmCallLog audit trail and the StatsCollector wired in, then cross-checks that
 * the two independent data paths agree:
 *
 *   - agentTurnStats.llmCallCount  === number of non-reflection llmCallLog entries
 *   - agentTurnStats token sums    === sum of llmCallLog usage for the same turn
 *   - agentTurnStats.costUsd       ≈  sum of llmCallLog per-call costs
 *   - missionStats lifetime totals === sum across the agent's turns
 *   - tool usage / sent messages   captured (PostMessage to the user)
 *
 * This is the end-to-end verification that the collector's incremental
 * aggregation matches the source-of-truth call log on a live run.
 *
 * Requires ANTHROPIC_API_KEY and MONGODB_URI in environment or .env file.
 * Requires setup-dev.sh (pool user magi-w1 must exist).
 */

import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTeamConfig } from "@magi/agent-config";
import { afterAll, describe, expect, it } from "vitest";
import {
	createMongoAgentStatsRepository,
	StatsCollector,
} from "../src/agent-stats.js";
import { createMongoConversationRepository } from "../src/conversation-repository.js";
import {
	createMongoLlmCallLogRepository,
	type LlmCallLogEntry,
} from "../src/llm-call-log.js";
import type { MailboxMessage } from "../src/mailbox.js";
import { createMongoMailboxRepository } from "../src/mailbox.js";
import { CLAUDE_SONNET, parseModel } from "../src/models.js";
import { connectMongo } from "../src/mongo.js";
import { runOrchestrationLoop } from "../src/orchestrator.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

const model = process.env.MODEL ? parseModel(process.env.MODEL) : CLAUDE_SONNET;

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI)
	throw new Error("MONGODB_URI env var is required for integration tests");

const TEAM_CONFIG_PATH = fileURLToPath(
	new URL("../../../config/teams/test/hello-world.yaml", import.meta.url),
);

/** Sum llmCallLog token/cost figures for entries matching a turn number. */
function sumLog(entries: LlmCallLogEntry[]) {
	return entries.reduce(
		(acc, e) => ({
			calls: acc.calls + 1,
			inputTokens: acc.inputTokens + e.usage.inputTokens,
			outputTokens: acc.outputTokens + e.usage.outputTokens,
			cacheReadTokens: acc.cacheReadTokens + e.usage.cacheReadTokens,
			cacheWriteTokens: acc.cacheWriteTokens + e.usage.cacheWriteTokens,
			costUsd: acc.costUsd + e.usage.cost.totalCostUsd,
		}),
		{
			calls: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		},
	);
}

describe("integration: StatsCollector matches llmCallLog on a real run", () => {
	const missionId = `stats-${randomUUID()}`;
	let client: Awaited<ReturnType<typeof connectMongo>>["client"] | null = null;

	afterAll(async () => {
		if (!client) return;
		const db = client.db();
		await Promise.all([
			db.collection("mailbox").deleteMany({ missionId }),
			db.collection("conversationMessages").deleteMany({ missionId }),
			db.collection("llmCallLog").deleteMany({ missionId }),
			db.collection("agentTurnStats").deleteMany({ missionId }),
			db.collection("missionStats").deleteMany({ missionId }),
		]);
		await client.close();
	});

	it("agentTurnStats and missionStats agree with the call log", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "magi-stats-"));
		chmodSync(tmpDir, 0o755);

		const conn = await connectMongo(MONGODB_URI);
		client = conn.client;
		const { db } = conn;

		const baseTeamConfig = loadTeamConfig(TEAM_CONFIG_PATH);
		const teamConfig = {
			...baseTeamConfig,
			mission: { ...baseTeamConfig.mission, id: missionId },
		};
		const agentId = teamConfig.agents[0].id; // "echo"

		const mailboxRepo = createMongoMailboxRepository(db, missionId);
		const conversationRepo = createMongoConversationRepository(db);
		const llmCallLog = createMongoLlmCallLogRepository(db);
		const statsRepo = createMongoAgentStatsRepository(db);
		const statsCollector = new StatsCollector(statsRepo);

		const workspaceManager = new WorkspaceManager({
			layout: {
				homeBase: join(tmpDir, "home"),
				missionsBase: join(tmpDir, "missions"),
			},
		});

		const userMessages: MailboxMessage[] = [];
		const ac = new AbortController();

		try {
			await mailboxRepo.post({
				missionId,
				from: "user",
				to: [agentId],
				subject: "Smoke test",
				body: "Are you working? Reply to confirm.",
			});

			await runOrchestrationLoop(
				{
					teamConfig,
					mailboxRepo,
					conversationRepo,
					llmCallLog,
					statsCollector,
					model,
					workdir: tmpDir,
					workspaceManager,
					maxRuns: 5,
					onUserMessage: (msg) => userMessages.push(msg),
				},
				ac.signal,
			);

			// The agent must have produced at least one turn of stats.
			const turns = await statsRepo.queryTurns({ missionId });
			expect(
				turns.length,
				"expected at least one agentTurnStats document",
			).toBeGreaterThanOrEqual(1);

			const log = await llmCallLog.query({ missionId, isReflection: false });
			expect(log.length, "expected llmCallLog entries").toBeGreaterThanOrEqual(
				1,
			);

			// Per-turn cross-check: collector aggregates == independent log sums.
			for (const turn of turns) {
				expect(turn.status).toBe("complete");
				const turnLog = log.filter(
					(e) => e.agentId === turn.agentId && e.turnNumber === turn.turnNumber,
				);
				const s = sumLog(turnLog);
				expect(
					turn.llmCallCount,
					`llmCallCount mismatch for turn ${turn.turnNumber}`,
				).toBe(s.calls);
				expect(turn.inputTokens).toBe(s.inputTokens);
				expect(turn.outputTokens).toBe(s.outputTokens);
				expect(turn.cacheReadTokens).toBe(s.cacheReadTokens);
				expect(turn.cacheWriteTokens).toBe(s.cacheWriteTokens);
				expect(turn.costUsd).toBeCloseTo(s.costUsd, 8);
				// peakContextTokens never exceeds the largest single-call context.
				const maxCtx = Math.max(
					0,
					...turnLog.map(
						(e) =>
							e.usage.inputTokens +
							e.usage.cacheReadTokens +
							e.usage.cacheWriteTokens,
					),
				);
				expect(turn.peakContextTokens).toBe(maxCtx);
			}

			// The echo agent replies to the user via PostMessage — tool + message
			// extraction must have captured it on some turn.
			const postMessageCalls = turns.reduce(
				(n, t) => n + (t.toolCalls.PostMessage ?? 0),
				0,
			);
			expect(
				postMessageCalls,
				"expected at least one PostMessage tool call recorded",
			).toBeGreaterThanOrEqual(1);
			const sentToUser = turns
				.flatMap((t) => t.messagesSent)
				.some((m) => m.to.includes("user"));
			expect(sentToUser, "expected a message sent to user").toBe(true);
			expect(userMessages.length).toBeGreaterThanOrEqual(1);

			// missionStats lifetime totals == sum across the agent's turns.
			const mission = await statsRepo.loadMission(missionId, agentId);
			expect(mission, "missionStats document must exist").not.toBeNull();
			const agentTurns = turns.filter((t) => t.agentId === agentId);
			const totalCalls = agentTurns.reduce((n, t) => n + t.llmCallCount, 0);
			const totalCost = agentTurns.reduce((n, t) => n + t.costUsd, 0);
			expect(mission?.lifetimeLlmCallCount).toBe(totalCalls);
			expect(mission?.lifetimeTurnCount).toBe(agentTurns.length);
			expect(mission?.lifetimeCostUsd).toBeCloseTo(totalCost, 8);
		} finally {
			ac.abort();
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}, 180_000); // 3-minute timeout — one real agent turn
});

describe("readMissionSnapshot + incrementLifetimeCostOnly against real MongoDB", () => {
	const missionId = `stats-snapshot-${randomUUID()}`;
	let client: Awaited<ReturnType<typeof connectMongo>>["client"] | null = null;

	afterAll(async () => {
		if (!client) return;
		const db = client.db();
		await Promise.all([
			db.collection("agentTurnStats").deleteMany({ missionId }),
			db.collection("missionStats").deleteMany({ missionId }),
		]);
		await client.close();
	});

	it("combines persisted lifetime cost with an in-flight turn's cost, fresh from Mongo", async () => {
		const conn = await connectMongo(MONGODB_URI);
		client = conn.client;
		const statsRepo = createMongoAgentStatsRepository(conn.db);
		const collector = new StatsCollector(statsRepo);

		// Agent "alpha": persisted lifetime cost from a completed turn, plus a
		// second turn currently running (not yet finalized).
		await collector.startTurn(missionId, "alpha", 0, false);
		await collector.recordLlmCall("alpha", {
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 1.5,
		});
		await collector.endTurn("alpha");
		await collector.startTurn(missionId, "alpha", 1, false);
		await collector.recordLlmCall("alpha", {
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.25,
		});

		// Agent "beta": a reflection call, recorded outside the turn lifecycle.
		await collector.recordReflectionCost(missionId, "beta", 0.4);

		// A second, independent collector instance (simulating a fresh daemon
		// process reading the same mission) must see exactly the same totals —
		// there is no in-memory cache to be out of sync with.
		const independent = new StatsCollector(statsRepo);
		const snapshot = await independent.readMissionSnapshot(missionId);
		const byAgent = new Map(snapshot.map((s) => [s.agentId, s]));

		expect(byAgent.get("alpha")?.lifetimeCostUsd).toBeCloseTo(1.5, 8);
		expect(byAgent.get("alpha")?.turnCostUsd).toBeCloseTo(0.25, 8);
		expect(byAgent.get("beta")?.lifetimeCostUsd).toBeCloseTo(0.4, 8);
		expect(byAgent.get("beta")?.turnCostUsd).toBe(0);

		const betaLifetime = await independent.readLifetime(missionId, "beta");
		expect(betaLifetime?.lifetimeTurnCount).toBe(0);
		expect(betaLifetime?.lifetimeLlmCallCount).toBe(1);

		await collector.endTurn("alpha");
	}, 30_000);
});
