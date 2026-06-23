/**
 * Sprint 24 phase 2 — Integration Test: hard-limit enforcement.
 *
 * Configures a tiny hard cap (`maxLlmCallsPerTurn: 1`) on the single-agent
 * hello-world team and runs a real turn. Proves the end-to-end enforcement path:
 * the limit breach throws out of the onLlmCall hook, the inner loop stops before
 * the next call, the turn is finalized as `aborted`, and a hard `onLimitAlert`
 * fires. (hello-world normally makes ≥2 calls: one to call PostMessage, one to
 * finish — so a cap of 1 reliably trips.)
 *
 * Requires ANTHROPIC_API_KEY and MONGODB_URI. Requires pool user magi-w1.
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
import type { LimitAlert } from "../src/limits.js";
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

describe("integration: hard-limit enforcement aborts a turn", () => {
	const missionId = `limits-${randomUUID()}`;
	let client: Awaited<ReturnType<typeof connectMongo>>["client"] | null = null;

	afterAll(async () => {
		if (!client) return;
		const db = client.db();
		await Promise.all([
			db.collection("mailbox").deleteMany({ missionId }),
			db.collection("conversationMessages").deleteMany({ missionId }),
			db.collection("agentTurnStats").deleteMany({ missionId }),
			db.collection("missionStats").deleteMany({ missionId }),
		]);
		await client.close();
	});

	it("maxLlmCallsPerTurn:1 aborts the turn and fires a hard alert", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "magi-limits-"));
		chmodSync(tmpDir, 0o755);

		const conn = await connectMongo(MONGODB_URI);
		client = conn.client;
		const { db } = conn;

		const base = loadTeamConfig(TEAM_CONFIG_PATH);
		const agentId = base.agents[0].id; // "echo"
		const teamConfig = {
			...base,
			mission: { ...base.mission, id: missionId },
			// Inject a tiny hard cap on the single agent.
			agents: [{ ...base.agents[0], limits: { maxLlmCallsPerTurn: 1 } }],
		};

		const mailboxRepo = createMongoMailboxRepository(db, missionId);
		const conversationRepo = createMongoConversationRepository(db);
		const statsRepo = createMongoAgentStatsRepository(db);
		const statsCollector = new StatsCollector(statsRepo);

		const workspaceManager = new WorkspaceManager({
			layout: {
				homeBase: join(tmpDir, "home"),
				missionsBase: join(tmpDir, "missions"),
			},
		});

		const alerts: LimitAlert[] = [];
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
					statsCollector,
					model,
					workdir: tmpDir,
					workspaceManager,
					maxRuns: 3,
					onLimitAlert: (a) => alerts.push(a),
				},
				ac.signal,
			);

			// A hard breach fired for the call-count rule.
			const hard = alerts.filter((a) => a.breach.rule.severity === "hard");
			expect(hard.length, "expected a hard limit alert").toBeGreaterThanOrEqual(
				1,
			);
			expect(hard[0].breach.rule.id).toBe("hard:maxLlmCallsPerTurn");
			expect(hard[0].agentId).toBe(agentId);

			// The turn was finalized as aborted.
			const turns = await statsRepo.queryTurns({ missionId });
			expect(turns.length).toBeGreaterThanOrEqual(1);
			const aborted = turns.find((t) => t.status === "aborted");
			expect(aborted, "expected an aborted turn").toBeDefined();
			// The cap is 1, so the breach is observed at call count 2 (the first call
			// over the threshold); enforcement throws before any further calls.
			expect(aborted?.llmCallCount).toBeGreaterThanOrEqual(2);
		} finally {
			ac.abort();
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}, 180_000);
});
