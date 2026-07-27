/**
 * Sprint 26 — end-to-end smoke test for the objectives spine, via the real
 * template path. Uses the `objectives-demo` team (config/teams/objectives-demo)
 * whose companion dir ships objectives/goals.json + tasks.jsonl as teamFiles.
 * Provisioning copies them onto disk as any other teamFile; this test's
 * onWorkspaceReady hook then runs the same boot-time self-migration
 * (ADR-0019) daemon.ts runs for every real mission, importing them into
 * MongoDB before the orchestration loop starts. Verifies the whole headless
 * loop, now Mongo-backed end to end:
 *   - migration: template goals.json/tasks.jsonl import into Mongo once
 *   - B1: the daemon injects the agent's #my-objectives mental-map region
 *   - A2: the agent calls the AddTask/UpdateTask/RecordKpi tools
 *   - A1: the repo folds the updates (tasks completed, KPI value set)
 *   - B2: the daemon attributes the turn's cost to the tasks
 *
 * Requires ANTHROPIC_API_KEY + MONGODB_URI and pool user magi-w1 (setup-dev.sh).
 */

import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
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
import { migrateLegacyObjectivesStore } from "../src/objectives/migrate-legacy-store.js";
import { createMongoObjectivesRepository } from "../src/objectives/repository.js";
import { runOrchestrationLoop } from "../src/orchestrator.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) throw new Error("MONGODB_URI required for integration tests");

const DEMO_DIR = fileURLToPath(
	new URL("../../../config/teams/objectives-demo", import.meta.url),
);
const TEAM_CONFIG_PATH = `${DEMO_DIR}.yaml`;

describe("integration: objectives spine end-to-end (template path)", () => {
	it("provisions template objectives, agent works tasks + KPI, daemon attributes cost", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "magi-obj-loop-"));
		chmodSync(tmpDir, 0o755); // pool user must traverse
		const missionId = `objectives-demo-${randomUUID()}`;
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
			const objectivesRepo = createMongoObjectivesRepository(db);
			// teamSkillsPath points at the demo's skills/; its dirname is the team
			// dir, so provisioning copies objectives/goals.json + tasks.jsonl onto
			// disk as plain teamFiles (unchanged, ADR-0021).
			const workspaceManager = new WorkspaceManager({
				layout: {
					homeBase: join(tmpDir, "home"),
					missionsBase: join(tmpDir, "missions"),
				},
				teamSkillsPath: join(DEMO_DIR, "skills"),
			});

			// Provision once here (idempotent — runOrchestrationLoop provisions
			// again internally) so the migration below can run to completion
			// before any agent turn starts. In production this same sequencing
			// (provision → migrate → seed, all before dispatch) happens inside
			// daemon.ts's onWorkspaceReady chain; that hook fires fire-and-forget
			// (not awaited) from inside runOrchestrationLoop, so a test relying on
			// it would race the first turn against migration completion.
			workspaceManager.provision(
				missionId,
				teamConfig.agents.map((a) => ({
					id: a.id,
					linuxUser: a.linuxUser ?? a.id,
				})),
			);
			await migrateLegacyObjectivesStore(sharedDir, missionId, objectivesRepo);

			await mailboxRepo.post({
				missionId,
				from: "user",
				to: ["officer"],
				subject: "Work your objectives",
				body: "Complete your assigned tasks and record your KPIs, then report back.",
			});

			const ac = new AbortController();
			await runOrchestrationLoop(
				{
					teamConfig,
					mailboxRepo,
					conversationRepo,
					statsCollector,
					objectivesRepo,
					model: CLAUDE_SONNET,
					workdir: tmpDir,
					workspaceManager,
					maxCycles: 8,
				},
				ac.signal,
			);

			// Migration + A1 + A2: template tasks folded and completed by the agent.
			const tree = await objectivesRepo.readTree(missionId);
			const byId = Object.fromEntries(tree.tasks.map((t) => [t.id, t]));
			expect(byId["TASK-1"]?.status, "TASK-1 should be completed").toBe(
				"completed",
			);
			expect(byId["TASK-2"]?.status, "TASK-2 should be completed").toBe(
				"completed",
			);

			// KPI the agent owns was recorded.
			const kpi = tree.objectives[0].kpis.find((k) => k.id === "K-coverage");
			expect(kpi?.value, "K-coverage should be recorded").not.toBeNull();

			// B2: cost attributed to the tasks.
			const costEvents = await objectivesRepo.readCostEvents(missionId);
			const attributed = costEvents
				.flatMap((e) => Object.values(e.alloc))
				.reduce((a, b) => a + b, 0);
			expect(attributed, "cost should be attributed").toBeGreaterThan(0);

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
			await db.collection("objectivesGoals").deleteMany({ missionId });
			await db.collection("objectivesEvents").deleteMany({ missionId });
			await client.close();
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}, 300_000);
});
