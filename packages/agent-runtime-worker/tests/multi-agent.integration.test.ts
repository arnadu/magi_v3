/**
 * Sprint 2 — Integration Test (Gate): Multi-agent word count
 * Sprint 6 — T6-1: Conversation persistence
 *
 * Scenario:
 *   - Lead receives a task: delegate word-count of greeting.txt to Worker.
 *   - Worker runs `wc -w greeting.txt` and reports the count back to Lead.
 *   - Lead reports the count to the user.
 *
 * Sprint 6 T6-1 assertion:
 *   - After the loop, conversationMessages collection contains documents for
 *     both agents.  Lead must have at least two distinct turnNumbers (ran
 *     twice: once to delegate, once to forward Worker's answer).
 *
 * Requires:
 *   - ANTHROPIC_API_KEY in environment or .env file.
 *   - MONGODB_URI in environment or .env file.
 *   - setup-dev.sh (pool users magi-w1, magi-w2 must exist).
 */

import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTeamConfig } from "@magi/agent-config";
import { describe, expect, it } from "vitest";
import { createMongoConversationRepository } from "../src/conversation-repository.js";
import type { MailboxMessage } from "../src/mailbox.js";
import { createMongoMailboxRepository } from "../src/mailbox.js";
import { createMongoMentalMapRepository } from "../src/mental-map.js";
import { CLAUDE_SONNET } from "../src/models.js";
import { connectMongo } from "../src/mongo.js";
import { runOrchestrationLoop } from "../src/orchestrator.js";
import type { AgentIdentity } from "../src/workspace-manager.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

// ---------------------------------------------------------------------------
// WorkspaceManager that seeds greeting.txt into Worker's workdir AFTER
// provision() has applied the default ACL — ensuring magi-w2 can read it.
// ---------------------------------------------------------------------------

class SeedingWorkspaceManager extends WorkspaceManager {
	private readonly greetingContent: string;

	constructor(
		opts: ConstructorParameters<typeof WorkspaceManager>[0],
		greetingContent: string,
	) {
		super(opts);
		this.greetingContent = greetingContent;
	}

	override provision(
		missionId: string,
		agents: Array<{ id: string; linuxUser: string }>,
	): Map<string, AgentIdentity> {
		const identities = super.provision(missionId, agents);
		const workerIdentity = identities.get("worker");
		if (workerIdentity) {
			// Written AFTER super.provision() sets the default ACL, so the file
			// inherits u:magi-w2:rwx automatically via the directory's default ACL.
			writeFileSync(
				join(workerIdentity.workdir, "greeting.txt"),
				this.greetingContent,
			);
		}
		return identities;
	}
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TEAM_CONFIG_PATH = fileURLToPath(
	new URL("../../../config/teams/word-count.yaml", import.meta.url),
);

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI)
	throw new Error("MONGODB_URI env var is required for integration tests");

// greeting.txt must contain exactly 12 words for the assertion to hold.
const GREETING_CONTENT =
	"HELLO WORLD this greeting contains exactly twelve words just for our test";

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("integration: multi-agent word count + conversation persistence", () => {
	it("Lead delegates to Worker; Worker counts 12 words; Lead reports to user; history persists", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "magi-multi-agent-"));
		// mkdtempSync creates with mode 0700 — pool users need execute to traverse.
		chmodSync(tmpDir, 0o755);
		const missionId = `word-count-${randomUUID()}`;
		const userMessages: MailboxMessage[] = [];

		const { client, db } = await connectMongo(MONGODB_URI);
		try {
			const baseTeamConfig = loadTeamConfig(TEAM_CONFIG_PATH);
			const teamConfig = {
				...baseTeamConfig,
				mission: { ...baseTeamConfig.mission, id: missionId },
			};

			const mailboxRepo = createMongoMailboxRepository(db, missionId);
			const mentalMapRepo = createMongoMentalMapRepository(db);
			const conversationRepo = createMongoConversationRepository(db);

			const workspaceManager = new SeedingWorkspaceManager(
				{
					layout: {
						homeBase: join(tmpDir, "home"),
						missionsBase: join(tmpDir, "missions"),
					},
				},
				GREETING_CONTENT,
			);

			// Seed Lead's inbox with the initial task.
			await mailboxRepo.post({
				missionId,
				from: "user",
				to: ["lead"],
				subject: "Word count task",
				body: "Count the number of words in the file greeting.txt and report the total to me.",
			});

			const ac = new AbortController();

			await runOrchestrationLoop(
				{
					teamConfig,
					mailboxRepo,
					mentalMapRepo,
					conversationRepo,
					model: CLAUDE_SONNET,
					workdir: tmpDir,
					workspaceManager,
					maxCycles: 20,
					onUserMessage: (msg) => {
						userMessages.push(msg);
						console.log(`\n[→ USER from ${msg.from}] ${msg.subject}`);
						console.log(msg.body.slice(0, 400));
					},
					onAgentMessage: (agentId, msg) => {
						if (msg.role === "assistant") {
							// biome-ignore lint/suspicious/noExplicitAny: pi-ai types
							for (const block of (msg as any).content ?? []) {
								if (block.type === "text" && block.text?.trim()) {
									console.log(
										`  [${agentId}] ${block.text.trim().slice(0, 200)}`,
									);
								} else if (block.type === "toolCall") {
									const args = JSON.stringify(block.arguments ?? {});
									const preview =
										args.length > 80 ? `${args.slice(0, 80)}…` : args;
									console.log(`  [${agentId}] → ${block.name}(${preview})`);
								}
							}
						} else if (msg.role === "toolResult") {
							// biome-ignore lint/suspicious/noExplicitAny: pi-ai types
							const tr = msg as any;
							const text = (tr.content ?? [])
								.filter((b: { type: string }) => b.type === "text")
								.map((b: { text: string }) => b.text)
								.join("")
								.trim();
							const preview =
								text.length > 150 ? `${text.slice(0, 150)}…` : text;
							console.log(`  [${agentId}] ← ${tr.toolName}: ${preview}`);
						}
					},
				},
				ac.signal,
			);

			// Sprint 2 assertion: Lead reported "12" to user.
			expect(userMessages.length).toBeGreaterThanOrEqual(1);
			const combined = userMessages.map((m) => m.body).join(" ");
			expect(combined).toMatch(/\b12\b/);

			// Sprint 6 T6-1: conversation history persisted to MongoDB.
			const col = db.collection("conversationMessages");

			const leadDocs = await col
				.find({ agentId: "lead", missionId })
				.sort({ turnNumber: 1, seqInTurn: 1 })
				.toArray();
			expect(leadDocs.length).toBeGreaterThan(0);

			// Lead ran at least twice: once to delegate, once to forward the answer.
			const leadTurns = new Set(leadDocs.map((d) => d.turnNumber));
			expect(leadTurns.size).toBeGreaterThanOrEqual(2);

			const workerDocs = await col
				.find({ agentId: "worker", missionId })
				.toArray();
			expect(workerDocs.length).toBeGreaterThan(0);
		} finally {
			// Clean up MongoDB state for this test run.
			await db.collection("mailbox").deleteMany({ missionId });
			await db.collection("conversationMessages").deleteMany({ missionId });
			await db
				.collection("mental_maps")
				.deleteMany({ agentId: { $in: ["lead", "worker"] } });
			await client.close();
			rmSync(tmpDir, { recursive: true });
		}
	}, 240_000); // 4-minute timeout — two agents, real LLM
});
