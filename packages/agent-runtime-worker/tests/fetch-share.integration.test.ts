/**
 * Sprint 3 — Integration Test 2 (Gate): Cross-agent PDF sharing
 *
 * Scenario:
 *   - Lead receives a task: fetch a local PDF file (served via HTTP).
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
 * Requires setup-dev.sh (pool users magi-w1, magi-w2 must exist).
 */

import { createReadStream, mkdtempSync, rmSync, statSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTeamConfig } from "@magi/agent-config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MailboxMessage } from "../src/mailbox.js";
import { InMemoryMailboxRepository } from "../src/mailbox.js";
import { InMemoryMentalMapRepository } from "../src/mental-map.js";
import { CLAUDE_SONNET } from "../src/models.js";
import { runOrchestrationLoop } from "../src/orchestrator.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

// ---------------------------------------------------------------------------
// Local HTTP server for test documents
// ---------------------------------------------------------------------------

const TEST_DOCS = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"testdata",
	"documents",
);

const MIME: Record<string, string> = {
	".html": "text/html",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".pdf": "application/pdf",
};

let server: http.Server;
let baseUrl: string;

beforeAll(
	() =>
		new Promise<void>((resolve) => {
			server = http.createServer((req, res) => {
				const filePath = join(TEST_DOCS, req.url ?? "/");
				try {
					const stat = statSync(filePath);
					const mime =
						MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
					res.writeHead(200, {
						"Content-Type": mime,
						"Content-Length": stat.size,
					});
					createReadStream(filePath).pipe(res);
				} catch {
					res.writeHead(404);
					res.end("Not found");
				}
			});
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address() as { port: number };
				baseUrl = `http://127.0.0.1:${addr.port}`;
				resolve();
			});
		}),
);

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ---------------------------------------------------------------------------
// Team config
// ---------------------------------------------------------------------------

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
			});

			const pdfUrl = `${baseUrl}/test-pdf.pdf`;

			// Seed Lead's inbox with the initial task
			await mailboxRepo.post({
				missionId: teamConfig.mission.id,
				from: "user",
				to: ["lead"],
				subject: "Document analysis task",
				body:
					`Please fetch this PDF document: ${pdfUrl}\n` +
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

			const combinedText = userMessages.map((m) => m.body).join(" ");

			// Lead must confirm the PDF was fetched (text content extracted).
			expect(combinedText).toMatch(/pdf|document|text|page/i);

			// Analyst must have described the image (dog/puppy visible on page 1).
			expect(combinedText).toMatch(/dog|puppy/i);
		} finally {
			rmSync(tmpDir, { recursive: true });
		}
	}, 360_000); // 6-minute timeout — multiple agents, LLM + vision calls
});
