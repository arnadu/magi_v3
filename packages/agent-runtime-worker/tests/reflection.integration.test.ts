/**
 * Sprint 9 — Integration Test: Reflection and Context Compaction
 *
 * Scenario:
 *   Session 1 — Agent is asked to fetch a PDF and summarise it.
 *     The Mental Map instructions direct it (and the reflection) to record
 *     document outline and chart data including the time of maximum speed.
 *   Session 2 — Agent is asked a specific follow-up question about the chart:
 *     "At what time does the chart show maximum speed?"
 *     The raw FetchUrl result body is gone (trimmed by reflection); the agent
 *     must rely on what reflection stored in the Mental Map + summary.
 *
 * Assertions after session 1:
 *   - conversationMessages contains a role:'summary' document for this agent
 *   - conversationMessages does NOT contain the raw FetchUrl tool-result body
 *     (old turns trimmed by reflection)
 *   - mental_maps finding-list is non-empty (reflection patched it)
 *
 * Assertions after session 2:
 *   - Agent's reply to user contains a time value (the chart maximum)
 *   - Session 2 conversation contains no FetchUrl tool_use block
 *     (agent answered from memory, not by re-fetching)
 *
 * This test WILL FAIL until Sprint 9 implements runReflection() in
 * src/reflection.ts. The stub is a no-op; the role:'summary' assertion is the
 * first to fail and serves as the acceptance gate.
 *
 * Requires ANTHROPIC_API_KEY and MONGODB_URI in environment or .env file.
 * Requires setup-dev.sh (pool user magi-w1 must exist).
 *
 * Low thresholds via env vars (set before import in vitest setup):
 *   REFLECTION_KEEP_TURNS=1  — keep only the last turn verbatim
 *   REFLECTION_THRESHOLD=2000 — trigger mid-session compaction after 2k tokens
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
import { createMongoMentalMapRepository } from "../src/mental-map.js";
import { CLAUDE_SONNET } from "../src/models.js";
import { connectMongo } from "../src/mongo.js";
import { runOrchestrationLoop } from "../src/orchestrator.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

// Low thresholds so even a small FetchUrl result triggers compaction.
process.env.REFLECTION_KEEP_TURNS = "1";
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
			const mentalMapRepo = createMongoMentalMapRepository(db);
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
					mentalMapRepo,
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

			// ── Assertions after session 1 ───────────────────────────────────────

			// 1. Reflection must have saved a summary document.
			const summaryDocs = await db
				.collection("conversationMessages")
				.find({ missionId, agentId: "researcher", "message.role": "summary" })
				.toArray();
			expect(
				summaryDocs.length,
				"reflection must produce a role:summary document in conversationMessages",
			).toBeGreaterThan(0);

			// 2. The raw FetchUrl tool-result body must have been trimmed.
			//    After trim, no document with the large FetchUrl content should remain
			//    (reflection replaces old raw results with a placeholder).
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
				"reflection must trim the raw FetchUrl tool-result from conversationMessages",
			).toBe(0);

			// 3. Mental Map finding-list must have been patched by reflection.
			const mentalMapHtml = await mentalMapRepo.load("researcher");
			expect(mentalMapHtml).toBeTruthy();
			const findingListMatch = mentalMapHtml?.match(
				/<ul id="finding-list">([\s\S]*?)<\/ul>/,
			);
			expect(
				findingListMatch?.[1]?.includes("<li>"),
				"reflection must patch the finding-list with at least one item",
			).toBe(true);

			// ── Session 2 ────────────────────────────────────────────────────────
			console.log("\n=== SESSION 2: recall chart maximum ===");

			await mailboxRepo.post({
				missionId,
				from: "user",
				to: ["researcher"],
				subject: "Follow-up question",
				body: "Looking at the document you analysed last session: at what time does the chart show maximum speed? Give me the specific value.",
			});

			const session2StartTime = new Date();
			await runOrchestrationLoop(
				{
					teamConfig,
					mailboxRepo,
					mentalMapRepo,
					conversationRepo,
					model: CLAUDE_SONNET,
					workdir: tmpDir,
					workspaceManager,
					maxCycles: 5,
					onUserMessage: (msg) => {
						userMessages.push(msg);
						console.log(`\n[→ USER] ${msg.subject}: ${msg.body.slice(0, 300)}`);
					},
				},
				ac.signal,
			);

			// ── Assertions after session 2 ───────────────────────────────────────

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
			const session2Docs = await db
				.collection("conversationMessages")
				.find({
					missionId,
					agentId: "researcher",
					"message.role": "assistant",
				})
				.toArray();

			// biome-ignore lint/suspicious/noExplicitAny: MongoDB document shape
			const session2FetchCalls = session2Docs.filter((d: any) =>
				(d.message?.content ?? []).some(
					// biome-ignore lint/suspicious/noExplicitAny: tool_use block
					(b: any) => b.type === "tool_use" && b.name === "FetchUrl",
				),
			);
			expect(
				session2FetchCalls.length,
				"session 2 must not re-fetch the PDF (agent answers from Mental Map / summary)",
			).toBe(0);
		} finally {
			await db.collection("mailbox").deleteMany({ missionId });
			await db.collection("conversationMessages").deleteMany({ missionId });
			await db.collection("mental_maps").deleteMany({ agentId: "researcher" });
			await client.close();
			rmSync(tmpDir, { recursive: true });
		}
	}, 300_000); // 5-minute timeout — two sessions + two reflection LLM calls
});
