/**
 * Sprint 2 integration test — two-agent word-count scenario.
 *
 * Scenario:
 *   - Lead receives: "Count the words in the file that contains HELLO WORLD."
 *   - Lead delegates word-count task to Worker (must NOT run Bash itself).
 *   - Worker runs wc -w on greeting.txt, replies to Lead.
 *   - Lead reports the count (12) back to the user.
 *
 * Requires ANTHROPIC_API_KEY in environment or .env file.
 *
 * Run:
 *   npx vitest run --config vitest.integration.config.ts \
 *     packages/agent-runtime-worker/tests/multi-agent.integration.test.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTeamConfig } from "@magi/agent-config";
import { describe, expect, it } from "vitest";
import type { MailboxMessage } from "../src/mailbox.js";
import { InMemoryMailboxRepository } from "../src/mailbox.js";
import { InMemoryMentalMapRepository } from "../src/mental-map.js";
import { CLAUDE_SONNET } from "../src/models.js";
import { runOrchestrationLoop } from "../src/orchestrator.js";

const WORD_COUNT_TEAM_YAML = `
mission:
  id: word-count-test
  name: Word Count Mission

agents:
  - id: lead
    name: Lead
    role: Lead Agent
    supervisor: user
    mission: |
      You coordinate the team.
      You MUST NOT use Bash or file tools yourself — ALL execution is done by Worker.
      When you receive a task: PostMessage to worker with precise instructions.
      Once Worker replies with results, PostMessage to user with the final answer.

  - id: worker
    name: Worker
    role: Worker Agent
    supervisor: lead
    mission: |
      You execute tasks assigned by Lead.
      When asked to find files: use Bash (e.g. grep -rl "HELLO WORLD" .).
      When asked to count words in a file: use Bash (wc -w <filename>).
      Reply to Lead via PostMessage with the exact result — nothing else.
`;

describe("integration: two-agent word-count", () => {
	it("Lead delegates to Worker and reports word count to user", async () => {
		// Set up a temp dir with a known file.
		const tmpDir = mkdtempSync(join(tmpdir(), "magi-multi-"));
		// "HELLO WORLD this is a test file with eleven words total end" = 12 words
		const fileContent =
			"HELLO WORLD this is a test file with eleven words total end\n";
		writeFileSync(join(tmpDir, "greeting.txt"), fileContent, "utf-8");

		const userMessages: MailboxMessage[] = [];

		try {
			const teamConfig = parseTeamConfig(WORD_COUNT_TEAM_YAML);
			const mailboxRepo = new InMemoryMailboxRepository();
			const mentalMapRepo = new InMemoryMentalMapRepository();

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
