/**
 * Sprint 26 — end-to-end smoke test for the objectives spine, via the real
 * template path. Uses the `objectives-demo` team (config/teams/objectives-demo)
 * whose companion dir ships objectives/goals.json + tasks.jsonl. Provisioning
 * copies them into the mission's shared store and makes it agent-writable; the
 * orchestration loop then runs the mission. Verifies the whole headless loop:
 *   - provisioning: template goals.json/tasks.jsonl land in a writable store
 *   - B1: the daemon injects the agent's #my-objectives mental-map region
 *   - A2: the agent runs the objectives skill scripts under sudo isolation
 *   - A1: the store folds the updates (tasks completed, KPI value set)
 *   - B2: the daemon attributes the turn's cost to the tasks (cost.jsonl)
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
import {
	loadCostEvents,
	loadObjectivesStore,
} from "../src/objectives/store.js";
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
			// teamSkillsPath points at the demo's skills/; its dirname is the team
			// dir, so provisioning copies objectives/goals.json + tasks.jsonl.
			const workspaceManager = new WorkspaceManager({
				layout: {
					homeBase: join(tmpDir, "home"),
					missionsBase: join(tmpDir, "missions"),
				},
				teamSkillsPath: join(DEMO_DIR, "skills"),
			});

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
					model: CLAUDE_SONNET,
					workdir: tmpDir,
					workspaceManager,
					maxCycles: 8,
				},
				ac.signal,
			);

			// Provisioning + A1 + A2: template tasks folded and completed by the agent.
			const tree = await loadObjectivesStore(sharedDir);
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
			const costEvents = await loadCostEvents(sharedDir);
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
			await client.close();
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}, 300_000);
});
