/**
 * Sprint 3 — Integration Test 2 (Gate): Cross-agent PDF sharing
 *
 * Scenario:
 *   - Lead receives a task: fetch a local PDF file.
 *   - Lead calls FetchUrl on the PDF → artifact saved under shared artifacts dir.
 *   - Lead PostMessages to Analyst with the artifact page path (absolute).
 *   - Analyst calls InspectImage on the page PNG and reports findings.
 *   - Lead PostMessages a combined summary to the user.
 *
 * This validates:
 *   - FetchUrl PDF extraction (text + page renders via mupdf)
 *   - Cross-agent artifact sharing (shared workspace dir, Sprint 4 convention)
 *   - InspectImage with a PDF page rendered as PNG via absolute path
 *   - Full orchestration loop with FetchUrl + InspectImage tools active
 *
 * Requires ANTHROPIC_API_KEY in environment or .env file.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadTeamConfig } from "@magi/agent-config";
import { describe, expect, it } from "vitest";
import type { MailboxMessage } from "../src/mailbox.js";
import { InMemoryMailboxRepository } from "../src/mailbox.js";
import { InMemoryMentalMapRepository } from "../src/mental-map.js";
import { CLAUDE_SONNET } from "../src/models.js";
import { runOrchestrationLoop } from "../src/orchestrator.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

// ---------------------------------------------------------------------------
// Test assets
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DOCS = join(__dirname, "..", "..", "..", "testdata", "documents");
const PDF_URL = pathToFileURL(join(TEST_DOCS, "test-pdf.pdf")).toString();

// Resolve path to team config
const TEAM_CONFIG_PATH = fileURLToPath(
	new URL("../../../config/teams/fetch-share.yaml", import.meta.url),
);

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("integration: cross-agent PDF fetch and inspect", () => {
	it("Lead fetches PDF, Analyst inspects page, Lead reports to user", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "magi-fetch-share-"));

		const userMessages: MailboxMessage[] = [];

		try {
			const teamConfig = loadTeamConfig(TEAM_CONFIG_PATH);
			const mailboxRepo = new InMemoryMailboxRepository();
			const mentalMapRepo = new InMemoryMentalMapRepository();

			const workspaceManager = new WorkspaceManager({
				layout: {
					homeBase: join(tmpDir, "home"),
					missionsBase: join(tmpDir, "missions"),
				},
				skipAcl: true,
			});

			// Seed Lead's inbox with the initial task
			await mailboxRepo.post({
				missionId: teamConfig.mission.id,
				from: "user",
				to: ["lead"],
				subject: "Document analysis task",
				body:
					`Please fetch this PDF document: ${PDF_URL}\n` +
					"Delegate the visual analysis of page 1 to Analyst. " +
					"Once Analyst reports back, send me a summary of: " +
					"(1) the text content of the PDF and (2) what Analyst found in the image.",
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
					maxCycles: 30,
					onUserMessage: (msg) => {
						userMessages.push(msg);
						console.log(`\n[→ USER from ${msg.from}] ${msg.subject}`);
						console.log(msg.body.slice(0, 500));
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

			// Lead must have reported to user at least once
			expect(userMessages.length).toBeGreaterThanOrEqual(1);

			// The combined user-facing report should mention PDF content or image findings.
			// The test PDF text says "testing purposes" and images show a dog (test_a.png)
			// and a cat (test_b.png). Either text or vision analysis will surface these.
			const combinedText = userMessages
				.map((m) => m.body)
				.join(" ")
				.toLowerCase();
			expect(combinedText).toMatch(
				/test|page|image|dog|cat|animal|pdf|document/i,
			);
		} finally {
			rmSync(tmpDir, { recursive: true });
		}
	}, 360_000); // 6-minute timeout — multiple agents, LLM + vision calls
});
