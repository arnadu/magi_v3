/**
 * Sprint 2 integration test — two-agent word-count scenario.
 *
 * Scenario:
 *   - Lead receives: "Count the words in the file that contains HELLO WORLD."
 *   - Lead finds the file (greeting.txt), delegates word-count task to Worker.
 *   - Worker counts words, replies to Lead.
 *   - Lead reports the count (11) back to the user.
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
      You coordinate the team. You receive tasks from the user and delegate work
      to your teammate Worker. Always PostMessage to Worker when you need work
      done, and PostMessage to user when you have a final answer.

  - id: worker
    name: Worker
    role: Worker Agent
    supervisor: lead
    mission: |
      You execute tasks assigned by Lead. When asked to count words in a file,
      use Bash to run: wc -w <filename>
      Then PostMessage back to Lead with the result.
`;

describe("integration: two-agent word-count", () => {
	it("Lead delegates to Worker and reports word count to user", async () => {
		// Set up a temp dir with a known file.
		const tmpDir = mkdtempSync(join(tmpdir(), "magi-multi-"));
		// "HELLO WORLD this is a test file with eleven words total end" = 11 words
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
				},
				ac.signal,
			);

			// The lead must have sent at least one message to "user".
			expect(userMessages.length).toBeGreaterThanOrEqual(1);

			// The final user-facing message should mention the word count.
			// The file has 11 words ("HELLO WORLD this is a test file with eleven words total end").
			// wc -w will report 11.
			const combinedText = userMessages.map((m) => m.body).join(" ");
			expect(combinedText).toMatch(/11/);
		} finally {
			rmSync(tmpDir, { recursive: true });
		}
	}, 300_000); // 5-minute timeout — multiple LLM calls
});
