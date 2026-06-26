/**
 * Sprint 26a — end-to-end smoke test for the objectives spine.
 *
 * Seeds a goals.json + tasks.jsonl into a mission's shared store, runs the real
 * orchestration loop, and verifies the whole headless loop:
 *   - B1: the daemon injects the agent's #my-objectives mental-map region.
 *   - A2: the agent runs the objectives skill scripts (task-update, record-kpi)
 *         under sudo isolation, appending to the store.
 *   - A1: the store folds the updates (task completed, KPI value set).
 *   - B2: the daemon attributes the turn's cost to TASK-1 (cost.jsonl).
 *
 * Requires ANTHROPIC_API_KEY + MONGODB_URI and pool user magi-w1 (setup-dev.sh).
 */

import { randomUUID } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTeamConfig } from "@magi/agent-config";
import { describe, expect, it } from "vitest";
import {
	createMongoAgentStatsRepository,
	StatsCollector,
} from "../src/agent-stats.js";
import { createMongoConversationRepository } from "../src/conversation-repository.js";
import { createMongoMailboxRepository } from "../src/mailbox.js";
import { CLAUDE_SONNET } from "../src/models.js";
import { connectMongo } from "../src/mongo.js";
import {
	loadCostEvents,
	loadObjectivesStore,
} from "../src/objectives/store.js";
import { runOrchestrationLoop } from "../src/orchestrator.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) throw new Error("MONGODB_URI required for integration tests");

const TEAM_CONFIG_PATH = fileURLToPath(
	new URL("../../../config/teams/test/objectives-test.yaml", import.meta.url),
);

const GOALS = {
	objectives: [
		{
			id: "OBJ-1",
			parent: null,
			title: "Q2 compliance",
			owner: "officer",
			status: "active",
			budgetUsd: 5,
			kpis: [
				{
					id: "K1",
					label: "records reconciled",
					owner: "officer",
					kind: "quantitative",
					source: "agent-reported",
				},
			],
		},
	],
};

describe("integration: objectives spine end-to-end", () => {
	it("agent reads #my-objectives, updates task + KPI via skill, daemon attributes cost", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "magi-obj-loop-"));
		chmodSync(tmpDir, 0o755); // pool user must traverse
		const missionId = `objectives-test-${randomUUID()}`;
		const sharedDir = join(tmpDir, "missions", missionId, "shared");

		const { client, db } = await connectMongo(MONGODB_URI);
		try {
			const base = loadTeamConfig(TEAM_CONFIG_PATH);
			const teamConfig = {
				...base,
				mission: { ...base.mission, id: missionId },
			};

			const mailboxRepo = createMongoMailboxRepository(db, missionId);
			const conversationRepo = createMongoConversationRepository(db);
			const statsCollector = new StatsCollector(
				createMongoAgentStatsRepository(db),
			);
			const workspaceManager = new WorkspaceManager({
				layout: {
					homeBase: join(tmpDir, "home"),
					missionsBase: join(tmpDir, "missions"),
				},
			});

			// Seed the agent's inbox so it wakes and runs one turn.
			await mailboxRepo.post({
				missionId,
				from: "user",
				to: ["officer"],
				subject: "Process your objectives",
				body: "Complete the two steps in your system prompt, then report back.",
			});

			const ac = new AbortController();
			await runOrchestrationLoop(
				{
					teamConfig,
					mailboxRepo,
					conversationRepo,
					statsCollector,
					model: CLAUDE_SONNET,
					workdir: tmpDir,
					workspaceManager,
					maxCycles: 6,
					// Seed the objectives store after provisioning (ACLs are set; the
					// objectives/ dir inherits the shared default ACL so the pool user
					// can append, and the daemon can read/write).
					onWorkspaceReady: () => {
						const objDir = join(sharedDir, "objectives");
						mkdirSync(objDir, { recursive: true });
						writeFileSync(join(objDir, "goals.json"), JSON.stringify(GOALS));
						writeFileSync(
							join(objDir, "tasks.jsonl"),
							`${JSON.stringify({
								id: "TASK-1",
								at: "2026-06-25T00:00:00.000Z",
								by: "user",
								title: "Inventory processing activities",
								objective: "OBJ-1",
								assignee: "officer",
								status: "open",
							})}\n`,
						);
					},
				},
				ac.signal,
			);

			// A1 + A2: the store folded the agent's skill writes.
			const tree = await loadObjectivesStore(sharedDir);
			const task = tree.tasks.find((t) => t.id === "TASK-1");
			expect(task?.status, "TASK-1 should be completed by the agent").toBe(
				"completed",
			);
			const kpi = tree.objectives[0].kpis.find((k) => k.id === "K1");
			expect(kpi?.value, "K1 should be recorded as 42").toBe(42);

			// B2: the daemon attributed the turn's cost to TASK-1.
			const costEvents = await loadCostEvents(sharedDir);
			const attributedToTask1 = costEvents
				.flatMap((e) => Object.entries(e.alloc))
				.filter(([id]) => id === "TASK-1")
				.reduce((sum, [, usd]) => sum + usd, 0);
			expect(
				attributedToTask1,
				"cost should be attributed to TASK-1",
			).toBeGreaterThan(0);

			// B1: the agent saw the daemon-managed #my-objectives region.
			const snapshot = await conversationRepo.loadMostRecentMentalMap(
				"officer",
				missionId,
			);
			expect(snapshot ?? "").toContain('data-managed="my-objectives"');
			expect(snapshot ?? "").toContain("TASK-1");
		} finally {
			await db.collection("mailbox").deleteMany({ missionId });
			await db.collection("conversationMessages").deleteMany({ missionId });
			await db.collection("agentTurnStats").deleteMany({ missionId });
			await db.collection("missionStats").deleteMany({ missionId });
			await db.collection("llmCallLog").deleteMany({ missionId });
			await client.close();
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}, 300_000); // 5 min — real LLM + skill subprocess
});
