/**
 * ADR-0018 — live limit-config integration test, real LLM + real MongoDB.
 *
 * Proves `enforceLimits` (agent-runner.ts) actually reads a hard limit fresh
 * from the mission's persisted teamConfigYaml rather than the boot-time
 * `teamConfig` snapshot the orchestrator was constructed with. The in-memory
 * `teamConfig` passed to `runOrchestrationLoop` here has NO limits configured
 * for the agent at all — the only place `maxLlmCallsPerTurn: 1` exists is the
 * `missions` collection document `missionConfig` reads from. A hard breach can
 * therefore only fire if the live read path is genuinely being used; the old
 * (pre-ADR-0018) behavior would run to completion with no abort.
 *
 * Requires ANTHROPIC_API_KEY and MONGODB_URI. Requires setup-dev.sh (pool
 * user magi-w1 must exist) — the agent needs a real Bash call to force a
 * second LLM call within the turn (tool result → next assistant message),
 * which is what enforceLimits re-checks against after.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTeamConfig } from "@magi/agent-config";
import { afterAll, describe, expect, it } from "vitest";
import {
	createMongoAgentStatsRepository,
	StatsCollector,
} from "../src/agent-stats.js";
import { createMongoConversationRepository } from "../src/conversation-repository.js";
import type { LimitAlert } from "../src/limits.js";
import type { MailboxMessage } from "../src/mailbox.js";
import { createMongoMailboxRepository } from "../src/mailbox.js";
import { createMongoMissionConfigRepository } from "../src/mission-config.js";
import { CLAUDE_SONNET, parseModel } from "../src/models.js";
import { connectMongo } from "../src/mongo.js";
import { runOrchestrationLoop } from "../src/orchestrator.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

const model = process.env.MODEL ? parseModel(process.env.MODEL) : CLAUDE_SONNET;

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI)
	throw new Error("MONGODB_URI env var is required for integration tests");

const teamYaml = (missionId: string) => `
mission:
  id: ${missionId}
  name: Live Limits Test

agents:
  - id: worker
    supervisor: user
    linuxUser: magi-w1
    systemPrompt: |
      You test tool usage. On every wakeup: first call Bash with command "echo hi",
      then call PostMessage to reply to the user with the Bash output. Always do
      both steps in that order — never skip the Bash call.
    initialMentalMap: <section id="tasks"></section>
`;

describe("integration: enforceLimits reads the agent's hard limit fresh, not from the boot-time snapshot", () => {
	const missionId = `limits-live-${randomUUID()}`;
	let client: Awaited<ReturnType<typeof connectMongo>>["client"] | null = null;

	afterAll(async () => {
		if (!client) return;
		const db = client.db();
		await Promise.all([
			db.collection("missions").deleteMany({ missionId }),
			db.collection("mailbox").deleteMany({ missionId }),
			db.collection("conversationMessages").deleteMany({ missionId }),
			db.collection("agentTurnStats").deleteMany({ missionId }),
			db.collection("missionStats").deleteMany({ missionId }),
		]);
		await client.close();
	});

	it("aborts the turn on a hard limit that exists only in the persisted config", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "magi-live-limits-"));
		chmodSync(tmpDir, 0o755);

		const conn = await connectMongo(MONGODB_URI);
		client = conn.client;
		const { db } = conn;

		// The boot-time teamConfig the orchestrator is constructed with — NO
		// `limits` block for "worker" at all, so a hard breach cannot come from
		// this object; it must come from a live read.
		const teamConfig = parseTeamConfig(teamYaml(missionId));

		// The persisted config a cockpit/copilot edit would have written —
		// diverges from the boot-time snapshot by exactly one hard limit.
		await db.collection("missions").insertOne({
			missionId,
			teamConfigYaml: teamYaml(missionId).replace(
				"linuxUser: magi-w1",
				"linuxUser: magi-w1\n    limits:\n      maxLlmCallsPerTurn: 1",
			),
		});

		const mailboxRepo = createMongoMailboxRepository(db, missionId);
		const conversationRepo = createMongoConversationRepository(db);
		const statsCollector = new StatsCollector(
			createMongoAgentStatsRepository(db),
		);
		const missionConfig = createMongoMissionConfigRepository(db);

		const workspaceManager = new WorkspaceManager({
			layout: {
				homeBase: join(tmpDir, "home"),
				missionsBase: join(tmpDir, "missions"),
			},
		});

		const userMessages: MailboxMessage[] = [];
		const limitAlerts: LimitAlert[] = [];
		const ac = new AbortController();

		try {
			await mailboxRepo.post({
				missionId,
				from: "user",
				to: ["worker"],
				subject: "Go",
				body: "Please run the Bash check and reply.",
			});

			await runOrchestrationLoop(
				{
					teamConfig,
					mailboxRepo,
					conversationRepo,
					statsCollector,
					missionConfig,
					model,
					workdir: tmpDir,
					workspaceManager,
					maxRuns: 5,
					onUserMessage: (msg) => userMessages.push(msg),
					onLimitAlert: (alert) => limitAlerts.push(alert),
				},
				ac.signal,
			);

			const hardAlert = limitAlerts.find(
				(a) => a.breach.rule.id === "hard:maxLlmCallsPerTurn",
			);
			expect(
				hardAlert,
				"expected a hard:maxLlmCallsPerTurn alert — this only fires if enforceLimits read the live config",
			).toBeDefined();

			const turns = await statsCollector.readMissionSnapshot(missionId);
			// The turn cost was still recorded even though it aborted — proves
			// the abort happened after at least one real LLM call, not before
			// the loop ever started.
			expect(
				turns.find((t) => t.agentId === "worker")?.lifetimeCostUsd,
			).toBeGreaterThan(0);
		} finally {
			ac.abort();
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}, 120_000);
});
