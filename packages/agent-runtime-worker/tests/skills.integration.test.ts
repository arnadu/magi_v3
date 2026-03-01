/**
 * Sprint 5 — Integration Test: Agent Skills
 *
 * Scenario:
 *   - Lead receives a task: create a report-format mission skill, then delegate
 *     PDF analysis to Worker using that skill.
 *   - Lead uses skill-creator (platform skill) to scaffold report-format.
 *   - Lead writes the SKILL.md requiring: ## TLDR, ## Sources, git commit.
 *   - Lead PostMessages to Worker with the PDF URL and skill instructions.
 *   - Worker discovers the report-format skill, fetches the PDF via FetchUrl,
 *     inspects page images via InspectImage, writes report.md with a TLDR,
 *     and commits via git-provenance.
 *   - Worker PostMessages the commit SHA back to Lead.
 *   - Lead reports to user.
 *
 * Assertions:
 *   1. report-format mission skill file was created by Lead.
 *   2. report.md in the shared folder contains a TLDR section.
 *   3. git log in the shared folder shows a commit authored by "worker".
 *   4. Lead sent at least one message to user.
 *
 * Requires:
 *   - ANTHROPIC_API_KEY in environment or .env file.
 *   - setup-dev.sh (pool users magi-w1, magi-w2 must exist).
 */

import { execFileSync } from "node:child_process";
import {
	createReadStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
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
import type { AgentIdentity } from "../src/workspace-manager.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

// ---------------------------------------------------------------------------
// Test-only WorkspaceManager: skip teardown so the sharedDir is still intact
// when we run filesystem assertions after runOrchestrationLoop returns.
// The test's finally block handles full cleanup via rmSync(tmpDir).
// ---------------------------------------------------------------------------

class NoTeardownWorkspaceManager extends WorkspaceManager {
	override teardown(
		_missionId: string,
		_identities: Map<string, AgentIdentity>,
	): void {
		// intentional no-op
	}
}

// ---------------------------------------------------------------------------
// Local HTTP server for test documents
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));

const TEST_DOCS = join(HERE, "..", "..", "..", "testdata", "documents");

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
// Paths
// ---------------------------------------------------------------------------

const TEAM_CONFIG_PATH = join(
	HERE,
	"..",
	"..",
	"..",
	"config",
	"teams",
	"skills-test.yaml",
);

// Platform skills: packages/skills/ in the repo root.
const PLATFORM_SKILLS_PATH = join(HERE, "..", "..", "..", "packages", "skills");

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MAGI_KEEP_WORKSPACE=1  — keep workspace after the test so you can inspect
//   files, git log, report.md, etc.  A fixed dir is used so the path is known:
//   /tmp/magi-skills-test/  (wiped at the START of the next run, not at the end)
// ---------------------------------------------------------------------------

const KEEP_WORKSPACE = Boolean(process.env.MAGI_KEEP_WORKSPACE);
const FIXED_WORKSPACE = join(tmpdir(), "magi-skills-test");

describe("integration: agent skills — skill creation and discovery", () => {
	it("Lead creates report-format skill; Worker follows it, commits report, reports to user", async () => {
		// Use a fixed, human-readable path when keeping; otherwise a fresh temp dir.
		const tmpDir = KEEP_WORKSPACE
			? FIXED_WORKSPACE
			: mkdtempSync(join(tmpdir(), "magi-skills-int-"));

		if (KEEP_WORKSPACE) {
			// Clean up from a previous keep-workspace run so state is fresh.
			rmSync(tmpDir, { recursive: true, force: true });
			mkdirSync(tmpDir, { recursive: true });
			console.log(
				`\n[test] Workspace: ${tmpDir}  (MAGI_KEEP_WORKSPACE=1 — not removed after test)\n`,
			);
		}

		const userMessages: MailboxMessage[] = [];

		try {
			const teamConfig = loadTeamConfig(TEAM_CONFIG_PATH);
			const mailboxRepo = new InMemoryMailboxRepository();
			const mentalMapRepo = new InMemoryMentalMapRepository();

			const workspaceManager = new NoTeardownWorkspaceManager({
				layout: {
					homeBase: join(tmpDir, "home"),
					missionsBase: join(tmpDir, "missions"),
				},
				platformSkillsPath: PLATFORM_SKILLS_PATH,
			});

			const pdfUrl = `${baseUrl}/test-pdf.pdf`;

			await mailboxRepo.post({
				missionId: teamConfig.mission.id,
				from: "user",
				to: ["lead"],
				subject: "Skills test task",
				body:
					"Create a report-format mission skill (with TLDR, Sources, and git commit " +
					"requirements), then delegate analysis of this PDF to Worker: " +
					`${pdfUrl}\n` +
					"Worker should follow the skill, write report.md in the shared folder, " +
					"commit it, and report back. Once Worker replies, report to me with a summary.",
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
					maxCycles: 40,
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

			// teardown is a no-op — sharedDir is still intact for assertions.
			const sharedDir = join(
				tmpDir,
				"missions",
				teamConfig.mission.id,
				"shared",
			);

			// 1. Lead created the report-format mission skill.
			const skillMdPath = join(
				sharedDir,
				"skills",
				"mission",
				"report-format",
				"SKILL.md",
			);
			expect(existsSync(skillMdPath)).toBe(true);

			// 2. report.md exists in the shared folder and contains a TLDR section.
			const reportPath = join(sharedDir, "report.md");
			expect(existsSync(reportPath)).toBe(true);
			const reportContent = readFileSync(reportPath, "utf-8");
			expect(reportContent).toMatch(/TLDR/i);

			// 3. The shared git repo has a commit authored by the worker agent.
			const gitLog = execFileSync(
				"git",
				["-C", sharedDir, "log", "--format=%an"],
				{ encoding: "utf-8" },
			);
			expect(gitLog).toMatch(/worker/i);

			// 4. Lead sent at least one message to the user.
			expect(userMessages.length).toBeGreaterThanOrEqual(1);
		} finally {
			if (!KEEP_WORKSPACE) {
				rmSync(tmpDir, { recursive: true });
			}
		}
	}, 480_000); // 8-minute timeout — multiple agents + LLM skill-creation + PDF fetch
});
