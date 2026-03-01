/**
 * Sprint 2 integration test — two-agent word-count scenario.
 *
 * Scenario:
 *   - Lead receives: "Count the words in the file that contains HELLO WORLD."
 *   - Lead delegates word-count task to Worker (must NOT run Bash itself).
 *   - Worker runs wc -w on greeting.txt, replies to Lead.
 *   - Lead reports the count (12) back to the user.
 *
 * Team config loaded from: config/teams/word-count.yaml
 *
 * Requires ANTHROPIC_API_KEY in environment or .env file.
 * Requires setup-dev.sh (pool users magi-w1, magi-w2 must exist).
 *
 * Run:
 *   npx vitest run --config vitest.integration.config.ts \
 *     packages/agent-runtime-worker/tests/multi-agent.integration.test.ts
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTeamConfig } from "@magi/agent-config";
import { describe, expect, it } from "vitest";
import type { MailboxMessage } from "../src/mailbox.js";
import { InMemoryMailboxRepository } from "../src/mailbox.js";
import { InMemoryMentalMapRepository } from "../src/mental-map.js";
import { CLAUDE_SONNET } from "../src/models.js";
import { runOrchestrationLoop } from "../src/orchestrator.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

// Resolve path to the shared team config YAML (project root / config / teams).
const TEAM_CONFIG_PATH = fileURLToPath(
	new URL("../../../config/teams/word-count.yaml", import.meta.url),
);

const POOL_USER_LEAD = "magi-w1";
const POOL_USER_WORKER = "magi-w2";

describe("integration: two-agent word-count", () => {
	it("Lead delegates to Worker and reports word count to user", async () => {
		// Set up a temp dir as the workspace root.
		const tmpDir = mkdtempSync(join(tmpdir(), "magi-multi-"));

		const userMessages: MailboxMessage[] = [];

		try {
			const teamConfig = loadTeamConfig(TEAM_CONFIG_PATH);
			const mailboxRepo = new InMemoryMailboxRepository();
			const mentalMapRepo = new InMemoryMentalMapRepository();

			const homeBase = join(tmpDir, "home");

			// Grant traverse-only access to tmpDir so pool users can navigate to their
			// workdirs (tmpDir has mode 700 from mkdtempSync). Per-workdir rwx ACLs
			// are applied by provision() via setfacl — not a broad recursive grant.
			spawnSync("setfacl", [
				"-m",
				`u:${POOL_USER_LEAD}:--x,u:${POOL_USER_WORKER}:--x`,
				tmpDir,
			]);

			const workspaceManager = new WorkspaceManager({
				layout: {
					homeBase,
					missionsBase: join(tmpDir, "missions"),
				},
			});

			// Provision workspaces explicitly so we can seed files after ACLs are
			// applied. runOrchestrationLoop() calls provision() again — it is idempotent.
			const identities = workspaceManager.provision(
				teamConfig.mission.id,
				teamConfig.agents.map((a) => ({
					id: a.id,
					linuxUser: a.linuxUser,
				})),
			);

			// Seed greeting.txt AFTER provision() so it inherits the directory's
			// default ACL (magi-w2 gets rwx on new files created in its workdir).
			// "HELLO WORLD this is a test file with eleven words total end" = 12 words
			const workerIdentity = identities.get("worker");
			if (!workerIdentity) throw new Error("worker identity not provisioned");
			writeFileSync(
				join(workerIdentity.workdir, "greeting.txt"),
				"HELLO WORLD this is a test file with eleven words total end\n",
				"utf-8",
			);

			// Seed the lead agent's inbox with the initial task.
			await mailboxRepo.post({
				missionId: teamConfig.mission.id,
				from: "user",
				to: ["lead"],
				subject: "Initial task",
				body: 'Count the words in the file that contains "HELLO WORLD" and report the count back to me.',
			});

			const ac = new AbortController();

			await runOrchestrationLoop(
				{
					teamConfig,
					mailboxRepo,
					mentalMapRepo,
					model: CLAUDE_SONNET,
					workdir: tmpDir,
					workspaceManager,
					maxCycles: 20,
					onUserMessage: (msg) => {
						userMessages.push(msg);
					},
					onAgentMessage: (agentId, msg) => {
						if (msg.role === "assistant") {
							// biome-ignore lint/suspicious/noExplicitAny: pi-ai types not re-exported
							for (const block of (msg as any).content ?? []) {
								if (block.type === "text" && block.text?.trim()) {
									console.log(`  [${agentId}] ${block.text.trim()}`);
								} else if (block.type === "toolCall") {
									const args = JSON.stringify(block.arguments ?? {});
									const preview =
										args.length > 80 ? `${args.slice(0, 80)}…` : args;
									console.log(`  [${agentId}] → ${block.name}(${preview})`);
								}
							}
						} else if (msg.role === "toolResult") {
							// biome-ignore lint/suspicious/noExplicitAny: pi-ai types not re-exported
							const tr = msg as any;
							const text = (tr.content ?? [])
								.filter((b: { type: string }) => b.type === "text")
								.map((b: { text: string }) => b.text)
								.join("")
								.trim();
							const preview =
								text.length > 100 ? `${text.slice(0, 100)}…` : text;
							console.log(`  [${agentId}] ← ${tr.toolName}: ${preview}`);
						}
					},
				},
				ac.signal,
			);

			// The lead must have sent at least one message to "user".
			expect(userMessages.length).toBeGreaterThanOrEqual(1);

			// The file has 12 words ("HELLO WORLD this is a test file with eleven words total end").
			// wc -w correctly reports 12.
			const combinedText = userMessages.map((m) => m.body).join(" ");
			expect(combinedText).toMatch(/12/);
		} finally {
			rmSync(tmpDir, { recursive: true });
		}
	}, 300_000); // 5-minute timeout — multiple LLM calls
});
