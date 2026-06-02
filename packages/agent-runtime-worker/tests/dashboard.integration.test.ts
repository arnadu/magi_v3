/**
 * Dashboard end-to-end integration test.
 *
 * Spins up a real MonitorServer + orchestration loop against the hello-world
 * team config, then drives the dashboard UI with Playwright to verify that:
 *   1. The operator can send a message via the compose bar.
 *   2. The message appears in the chat panel immediately.
 *   3. The agent reply appears in the same chat thread (same participant set).
 *
 * Requires:
 *   - ANTHROPIC_API_KEY and MONGODB_URI in .env
 *   - setup-dev.sh (pool users magi-w1 must exist)
 *   - Playwright Chromium: npm run install:browsers -w packages/agent-runtime-worker
 */

import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTeamConfig } from "@magi/agent-config";
import type { Db } from "mongodb";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { createMongoConversationRepository } from "../src/conversation-repository.js";
import { createMongoMailboxRepository } from "../src/mailbox.js";
import { CLAUDE_SONNET } from "../src/models.js";
import { connectMongo } from "../src/mongo.js";
import type { AgentInfo } from "../src/monitor-server.js";
import { MonitorServer } from "../src/monitor-server.js";
import { runOrchestrationLoop } from "../src/orchestrator.js";
import { UsageAccumulator } from "../src/usage.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const TEAM_CONFIG_PATH = join(REPO_ROOT, "config/teams/test/hello-world.yaml");
const PLATFORM_SKILLS = join(REPO_ROOT, "packages/skills");
const PUBLIC_DIR = join(REPO_ROOT, "packages/agent-runtime-worker/public");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close((err) => (err ? reject(err) : resolve(port)));
		});
	});
}

function makeWaitForMail(
	db: Db,
	missionId: string,
	signal: AbortSignal,
): () => Promise<void> {
	function openStream(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const stream = db.collection("mailbox").watch(
				[
					{
						$match: {
							operationType: "insert",
							"fullDocument.missionId": missionId,
						},
					},
				],
				{ fullDocument: "updateLookup" },
			);
			const onAbort = () => {
				stream.close().catch(() => {});
				resolve();
			};
			signal.addEventListener("abort", onAbort, { once: true });
			stream.once("change", () => {
				signal.removeEventListener("abort", onAbort);
				stream.close().catch(() => {});
				resolve();
			});
			stream.once("error", (err: Error) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			});
		});
	}

	return async function waitForMail(): Promise<void> {
		if (signal.aborted) return;
		while (!signal.aborted) {
			try {
				await openStream();
				return;
			} catch {
				if (signal.aborted) return;
				await new Promise<void>((res) => setTimeout(res, 1_000));
			}
		}
	};
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("dashboard — message round-trip", () => {
	it("operator message appears in chat and agent reply follows in same thread", async () => {
		const missionId = `dashboard-test-${randomUUID()}`;
		const MONGODB_URI = process.env.MONGODB_URI ?? "";
		const port = await freePort();
		const workdir = mkdtempSync(join(tmpdir(), "magi-dashboard-test-"));
		// Pool users (magi-w1) need execute permission to traverse the workdir.
		chmodSync(workdir, 0o755);

		const { client, db } = await connectMongo(MONGODB_URI, "magi-test");
		const mailboxRepo = createMongoMailboxRepository(db, missionId);
		const conversationRepo = createMongoConversationRepository(db);

		const baseConfig = await loadTeamConfig(TEAM_CONFIG_PATH);
		const teamConfig = {
			...baseConfig,
			mission: { ...baseConfig.mission, id: missionId },
		};

		const accumulator = new UsageAccumulator();
		const agentInfos: AgentInfo[] = teamConfig.agents.map((a) => ({
			id: a.id,
			name: a.name ?? a.id,
			role: a.role,
		}));

		const abortCtrl = new AbortController();

		const sharedDir = join(workdir, "missions", missionId, "shared");
		const monitor = new MonitorServer(
			db,
			missionId,
			teamConfig.mission.name,
			CLAUDE_SONNET,
			accumulator,
			mailboxRepo,
			agentInfos,
			() => abortCtrl.abort(),
			null,
			new Date(),
			workdir,
			sharedDir,
			undefined, // cancelSchedule
			PUBLIC_DIR,
		);

		await monitor.start(port);

		const workspaceManager = new WorkspaceManager({
			layout: {
				homeBase: join(workdir, "home"),
				missionsBase: join(workdir, "missions"),
			},
			platformSkillsPath: PLATFORM_SKILLS,
		});

		const waitForMail = makeWaitForMail(db, missionId, abortCtrl.signal);

		// Start orchestration loop in background; it runs until aborted.
		const loopPromise = (async () => {
			await monitor.waitForStart();
			await runOrchestrationLoop(
				{
					teamConfig,
					mailboxRepo,
					conversationRepo,
					model: CLAUDE_SONNET,
					workdir,
					workspaceManager,
					teardownOnExit: true,
					waitForMail,
					onWorkspaceReady: (wdirs) => monitor.setAgentWorkdirs(wdirs),
					onAgentStart: (id) => monitor.notifyAgentStart(id),
					onAgentDone: (id) => monitor.notifyAgentDone(id),
					onIdle: () => monitor.notifyIdle(),
				},
				abortCtrl.signal,
			);
		})().catch((err) => {
			if (!abortCtrl.signal.aborted)
				console.error("[test] orchestration error:", err);
		});

		// ── Playwright ────────────────────────────────────────────────────
		const browser = await chromium.launch({ headless: true });
		const page = await browser.newPage();

		const consoleLogs: string[] = [];
		page.on("console", (msg) => {
			consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
		});
		page.on("pageerror", (err) => {
			consoleLogs.push(`[pageerror] ${err.message}`);
		});

		try {
			await page.goto(`http://127.0.0.1:${port}`);

			// Click ▶ Start to unblock the orchestration loop.
			await page.waitForSelector("#start-btn");
			await page.click("#start-btn");

			// Select the echo agent chip in the compose bar.
			await page.waitForSelector(".recipient-chip");
			await page.locator(".recipient-chip").first().click();

			// Type and send a message.
			await page.fill("#compose-body", "Hello from dashboard test");
			await page.locator(".compose-bar button").last().click();

			// Our own message should appear immediately in the chat view.
			await page.waitForSelector(".bubble.ab-user", { timeout: 10_000 });
			const userBubble = await page
				.locator(".bubble.ab-user")
				.first()
				.textContent();
			expect(userBubble).toContain("Hello from dashboard test");

			// Agent reply should appear in the same thread (ab-echo bubble).
			await page.waitForSelector(".bubble.ab-echo", { timeout: 60_000 });
			const agentBubble = await page
				.locator(".bubble.ab-echo")
				.first()
				.textContent();
			expect(agentBubble).toBeTruthy();
			console.log("[test] agent reply:", agentBubble?.slice(0, 120));

			// Verify both bubbles are visible at the same time (same thread).
			const bubbles = await page.locator(".bubble").count();
			expect(bubbles).toBeGreaterThanOrEqual(2);
		} catch (err) {
			// Capture a screenshot and all console logs on failure.
			const screenshotPath = join(
				tmpdir(),
				`dashboard-test-fail-${Date.now()}.png`,
			);
			await page
				.screenshot({ path: screenshotPath, fullPage: true, timeout: 5_000 })
				.catch(() => {});
			console.error("[test] FAILED — screenshot:", screenshotPath);
			console.error("[test] browser console:\n", consoleLogs.join("\n"));
			throw err;
		} finally {
			await browser.close();
		}

		// ── Cleanup ───────────────────────────────────────────────────────
		abortCtrl.abort();
		await loopPromise;
		monitor.stop();

		await db.collection("mailbox").deleteMany({ missionId });
		await db.collection("conversationMessages").deleteMany({ missionId });
		await db.collection("llmCallLog").deleteMany({ missionId });
		await client.close();

		try {
			rmSync(workdir, { recursive: true, force: true });
		} catch {
			/**/
		}
	}, 120_000);
});
