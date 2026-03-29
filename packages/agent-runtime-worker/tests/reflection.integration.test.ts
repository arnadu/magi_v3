/**
 * Sprint 9 — Integration Test: Reflection and Context Compaction
 *
 * Scenario:
 *   Session 1 — Agent is asked to fetch a PDF and summarise it.
 *     The Mental Map instructions direct it (and the reflection) to record
 *     document outline and chart data including the time of maximum speed.
 *   Session 2 — Agent is asked a specific follow-up question about the chart:
 *     "At what time does the chart show maximum speed?"
 *     Reflection fires at the START of session 2 (on session 1's messages),
 *     updating the Mental Map and compacting the raw FetchUrl result. The agent
 *     must then rely on what reflection stored in the Mental Map + summary.
 *
 * Assertions after session 2 (reflection has run by then):
 *   1. conversationMessages contains a role:'summary' document for this agent
 *   2. conversationMessages FetchUrl tool-result has compacted: true
 *      (retained for audit/RAG; excluded from prompt preparation)
 *   3. mental_maps finding-list is non-empty (reflection patched it)
 *   4. Agent's reply to user contains a time value (the chart maximum)
 *   5. Session 2 conversation contains no FetchUrl tool_use block
 *      (agent answered from memory, not by re-fetching)
 *
 * Requires ANTHROPIC_API_KEY and MONGODB_URI in environment or .env file.
 * Requires setup-dev.sh (pool user magi-w1 must exist).
 *
 * Low threshold via env var (set before import in vitest setup):
 *   REFLECTION_THRESHOLD=2000 — trigger mid-session compaction after 2k tokens (Sprint 10)
 */

import { randomUUID } from "node:crypto";
import {
	chmodSync,
	createReadStream,
	mkdtempSync,
	rmSync,
	statSync,
} from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTeamConfig } from "@magi/agent-config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMongoConversationRepository } from "../src/conversation-repository.js";
import type { MailboxMessage } from "../src/mailbox.js";
import { createMongoMailboxRepository } from "../src/mailbox.js";
import { CLAUDE_SONNET } from "../src/models.js";
import { connectMongo } from "../src/mongo.js";
import { runOrchestrationLoop } from "../src/orchestrator.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

// REFLECTION_THRESHOLD=2000: any real FetchUrl result exceeds this, exercising
// mid-session threshold code paths (when implemented in Sprint 10).
process.env.REFLECTION_THRESHOLD = "2000";

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI)
	throw new Error("MONGODB_URI env var is required for integration tests");

// ---------------------------------------------------------------------------
// Local HTTP server — reuse testdata/documents/ (same PDF as fetch-share test)
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
	new URL("../../../config/teams/reflection-test.yaml", import.meta.url),
);

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("integration: reflection and context compaction", () => {
	it("session 1 compacted, session 2 recalls chart maximum without re-fetching", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "magi-reflection-"));
		chmodSync(tmpDir, 0o755);
		const missionId = `reflection-${randomUUID()}`;
		const userMessages: MailboxMessage[] = [];

		const { client, db } = await connectMongo(MONGODB_URI);
		try {
			const baseTeamConfig = loadTeamConfig(TEAM_CONFIG_PATH);
			const teamConfig = {
				...baseTeamConfig,
				mission: { ...baseTeamConfig.mission, id: missionId },
			};

			const mailboxRepo = createMongoMailboxRepository(db, missionId);
			const conversationRepo = createMongoConversationRepository(db);

			const workspaceManager = new WorkspaceManager({
				layout: {
					homeBase: join(tmpDir, "home"),
					missionsBase: join(tmpDir, "missions"),
				},
			});

			const pdfUrl = `${baseUrl}/test-pdf.pdf`;
			const ac = new AbortController();

			// ── Session 1 ────────────────────────────────────────────────────────

			console.log("\n=== SESSION 1: fetch and summarise PDF ===");

			await mailboxRepo.post({
				missionId,
				from: "user",
				to: ["researcher"],
				subject: "Document analysis",
				body:
					`Please fetch this document: ${pdfUrl}\n` +
					"Summarise its contents. Make sure to record all chart data " +
					"(including specific values and time points) in your notes, " +
					"then report the summary to me.",
			});

			await runOrchestrationLoop(
				{
					teamConfig,
					mailboxRepo,
					conversationRepo,
					model: CLAUDE_SONNET,
					workdir: tmpDir,
					workspaceManager,
					maxCycles: 10,
					onUserMessage: (msg) => {
						userMessages.push(msg);
						console.log(`\n[→ USER] ${msg.subject}: ${msg.body.slice(0, 300)}`);
					},
				},
				ac.signal,
			);

			// Agent must have reported to user after session 1.
			expect(userMessages.length).toBeGreaterThanOrEqual(1);

			// ── Session 2 ────────────────────────────────────────────────────────
			// Reflection fires at the START of session 2 (on session 1's messages).
			// Assertions on compaction / summary / Mental Map patches are therefore
			// checked after session 2 completes (reflection has run by then).

			console.log("\n=== SESSION 2: recall chart maximum ===");

			await mailboxRepo.post({
				missionId,
				from: "user",
				to: ["researcher"],
				subject: "Follow-up question",
				body: "Looking at the document you analysed last session: at what time does the chart show maximum speed? Give me the specific value.",
			});

			let session2FetchCalled = false;
			const session2StartTime = new Date();

			await runOrchestrationLoop(
				{
					teamConfig,
					mailboxRepo,
					conversationRepo,
					model: CLAUDE_SONNET,
					workdir: tmpDir,
					workspaceManager,
					maxCycles: 5,
					onUserMessage: (msg) => {
						userMessages.push(msg);
						console.log(`\n[→ USER] ${msg.subject}: ${msg.body.slice(0, 300)}`);
					},
					onAgentMessage: (_agentId, msg) => {
						if (msg.role === "assistant") {
							// biome-ignore lint/suspicious/noExplicitAny: pi-ai AssistantMessage
							for (const block of (msg as any).content ?? []) {
								if (block.type === "toolCall" && block.name === "FetchUrl") {
									session2FetchCalled = true;
								}
							}
						}
					},
				},
				ac.signal,
			);

			// ── Assertions after session 2 ───────────────────────────────────────

			// 1. Reflection must have saved a summary document.
			const summaryDocs = await db
				.collection("conversationMessages")
				.find({ missionId, agentId: "researcher", "message.role": "summary" })
				.toArray();
			expect(
				summaryDocs.length,
				"reflection must produce a role:summary document in conversationMessages",
			).toBeGreaterThan(0);

			// 2. The raw FetchUrl tool-result must be marked compacted (not deleted —
			//    documents are retained for auditability and future RAG retrieval).
			const rawFetchDocs = await db
				.collection("conversationMessages")
				.find({
					missionId,
					agentId: "researcher",
					"message.toolName": "FetchUrl",
				})
				.toArray();
			expect(
				rawFetchDocs.length,
				"FetchUrl tool-result document must still exist (retained for audit/RAG)",
			).toBe(1);
			expect(
				rawFetchDocs[0].compacted,
				"FetchUrl tool-result must be marked compacted: true",
			).toBe(true);

			// 3. Mental Map finding-list must have been patched by reflection.
			const { client: c2, db: db2 } = await connectMongo(MONGODB_URI);
			const mmDoc = await db2.collection("conversationMessages").findOne(
				{ agentId: "researcher", missionId, mentalMapHtml: { $exists: true } },
				{ sort: { turnNumber: -1, seqInTurn: -1 } },
			);
			// biome-ignore lint/suspicious/noExplicitAny: dynamic doc
			const mentalMapHtml = (mmDoc as any)?.mentalMapHtml ?? null;
			await c2.close();
			expect(mentalMapHtml).toBeTruthy();
			const findingListMatch = mentalMapHtml?.match(
				/<ul id="finding-list">([\s\S]*?)<\/ul>/,
			);
			expect(
				findingListMatch?.[1]?.includes("<li>"),
				"reflection must patch the finding-list with at least one item",
			).toBe(true);

			// 4. Agent must have replied to user with a time value.
			const session2UserMsgs = userMessages.filter(
				(m) => m.timestamp >= session2StartTime,
			);
			expect(
				session2UserMsgs.length,
				"agent must reply to user in session 2",
			).toBeGreaterThanOrEqual(1);

			const session2Reply = session2UserMsgs.map((m) => m.body).join(" ");
			expect(
				session2Reply,
				"session 2 reply must contain a time or numeric value (chart maximum)",
			).toMatch(/\d/);

			// 5. Session 2 must NOT have called FetchUrl (answer came from memory).
			expect(
				session2FetchCalled,
				"session 2 must not re-fetch the PDF (agent answers from Mental Map / summary)",
			).toBe(false);
		} finally {
			await db.collection("mailbox").deleteMany({ missionId });
			await db.collection("conversationMessages").deleteMany({ missionId });
			await client.close();
			rmSync(tmpDir, { recursive: true });
		}
	}, 300_000); // 5-minute timeout — two sessions + one reflection LLM call
});
