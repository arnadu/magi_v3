/**
 * Sprint 12 — Integration Test: daemon background job execution
 *
 * Scenario:
 *   A "data-researcher" agent is asked to submit a one-shot background job
 *   via submit-job.sh. The daemon picks it up on its next heartbeat (≤60s),
 *   spawns it with MAGI_TOOL_TOKEN injected, and notifies the agent on
 *   completion. The agent forwards the result to the user.
 *
 * What this tests end-to-end:
 *   1. Agent submits a job via submit-job.sh (Bash tool)
 *   2. Daemon heartbeat picks up the pending job (≤60s)
 *   3. Job runs as magi-w1 via sudo, MAGI_TOOL_TOKEN injected
 *   4. Job calls magi-tool post-message → ToolApiServer → mailbox insert
 *   5. Daemon notifyAgentId path: scheduler posts completion message
 *   6. Change Stream wakes the orchestration loop
 *   7. Agent second cycle: reads notifications, reports to user
 *
 * The job script:
 *   - Writes a marker file to /tmp/magi-daemon-job-test/job-ran.txt
 *   - Calls magi-tool post-message with subject "test-job-via-token"
 *
 * Assertions:
 *   1. Job marker file exists (script actually ran under magi-w1)
 *   2. Job status file exists with exitCode 0
 *   3. Mailbox message with subject "test-job-via-token" exists (MAGI_TOOL_TOKEN worked)
 *   4. User received at least one message from the agent
 *
 * Requires: ANTHROPIC_API_KEY + MONGODB_URI in .env
 * Requires: magi-node, magi-tool, magi-w1 pool user (scripts/setup-dev.sh)
 *
 * Timeout: 4 minutes (agent cycle × 2 + heartbeat ≤60s + job execution)
 */

import { execSync, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createMongoMailboxRepository } from "../src/mailbox.js";
import { connectMongo } from "../src/mongo.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) throw new Error("MONGODB_URI is required for integration tests");

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const TEAM_CONFIG_PATH = join(
	REPO_ROOT,
	"config", "teams", "daemon-job-test.yaml",
);

const MISSION_ID = "daemon-job-test";
const MONITOR_PORT = 4010;
const TOOL_PORT = 4011;

/** Fixed output dir — preserved between runs for inspection. Cleaned at test start. */
const OUTPUT_DIR = join(tmpdir(), "magi-daemon-job-test");

/** Marker file written by the job script to prove it ran as magi-w1. */
const MARKER_FILE = join(OUTPUT_DIR, "job-ran.txt");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Poll a URL until it responds 200 or timeout expires. */
async function waitForHttp(
	url: string,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url);
			if (res.ok) return;
		} catch {
			// not ready yet
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`Timed out waiting for ${url}`);
}

/** Poll MongoDB mailbox until a message to "user" appears, or timeout. */
async function waitForUserMessage(
	// biome-ignore lint/suspicious/noExplicitAny: MongoDB Db
	db: any,
	missionId: string,
	timeoutMs: number,
): Promise<unknown> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const msg = await db
			.collection("mailbox")
			.findOne({ missionId, to: { $in: ["user"] } });
		if (msg) return msg;
		await new Promise((r) => setTimeout(r, 2_000));
	}
	throw new Error("Timed out waiting for user message");
}

/** Poll MongoDB mailbox until a message with the given subject appears. */
async function waitForMailboxSubject(
	// biome-ignore lint/suspicious/noExplicitAny: MongoDB Db
	db: any,
	missionId: string,
	subject: string,
	timeoutMs: number,
): Promise<unknown> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const msg = await db
			.collection("mailbox")
			.findOne({ missionId, subject });
		if (msg) return msg;
		await new Promise((r) => setTimeout(r, 2_000));
	}
	throw new Error(`Timed out waiting for mailbox message with subject "${subject}"`);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("integration: daemon background job execution (Sprint 12)", () => {
	let daemonProc: ReturnType<typeof spawn> | null = null;
	let workdir: string;
	let sharedDir: string;
	let jobScriptPath: string;

	beforeAll(async () => {
		// ── Clean previous run ───────────────────────────────────────────────
		try { rmSync(OUTPUT_DIR, { recursive: true, force: true }); } catch {}
		mkdirSync(OUTPUT_DIR, { recursive: true });
		workdir = OUTPUT_DIR;

		sharedDir = join(workdir, "missions", MISSION_ID, "shared");
		// Script must live inside sharedDir — the daemon validates scriptPath against
		// permittedPaths (agentWorkdir + sharedDir) before executing.
		mkdirSync(sharedDir, { recursive: true });
		jobScriptPath = join(sharedDir, "test-job.sh");

		// ── Wipe MongoDB data from previous runs ─────────────────────────────
		{
			const { client, db } = await connectMongo(MONGODB_URI!);
			try {
				for (const coll of ["mailbox", "conversationMessages", "llmCallLog", "scheduled_messages"]) {
					await db.collection(coll).deleteMany({ missionId: MISSION_ID });
				}
				// Also remove the PID file from any prior run.
				const pidFile = join(workdir, "missions", MISSION_ID, "daemon.pid");
				try { rmSync(pidFile); } catch {}
			} finally {
				await client.close();
			}
		}

		// ── Write the test job script ────────────────────────────────────────
		// The script runs as magi-w1 via sudo. It:
		//   1. Writes a marker file to OUTPUT_DIR (world-writable /tmp subdir)
		//   2. Calls magi-tool post-message to test MAGI_TOOL_TOKEN injection
		mkdirSync(OUTPUT_DIR, { recursive: true });
		chmodSync(OUTPUT_DIR, 0o1777); // sticky + world-writable so magi-w1 can write

		writeFileSync(jobScriptPath, [
			"#!/bin/sh",
			`# Test job — runs as magi-w1 under the daemon`,
			`echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${MARKER_FILE}"`,
			`magi-tool post-message \\`,
			`  --to data-researcher \\`,
			`  --subject "test-job-via-token" \\`,
			`  --body "MAGI_TOOL_TOKEN works — job ran at $(date -u)"`,
		].join("\n"));
		chmodSync(jobScriptPath, 0o755);
	}, 60_000);

	it(
		"agent submits job, daemon runs it with token, agent reports result",
		async () => {
			const { client, db } = await connectMongo(MONGODB_URI!);
			const mailboxRepo = createMongoMailboxRepository(db, MISSION_ID);
			const submitJobScript = join(
				sharedDir,
				"skills", "_platform", "run-background", "scripts", "submit-job.sh",
			);

			try {
				// ── Start the daemon subprocess ──────────────────────────────────
				const daemonDir = join(REPO_ROOT, "packages", "agent-runtime-worker");
				daemonProc = spawn(
					"node",
					[
						"--import", "./dist/node-polyfill.js",
						"dist/daemon.js",
					],
					{
						cwd: daemonDir,
						env: {
							...process.env,
							TEAM_CONFIG: TEAM_CONFIG_PATH,
							MONGODB_URI: MONGODB_URI!,
							AGENT_WORKDIR: workdir,
							MONITOR_PORT: String(MONITOR_PORT),
							TOOL_PORT: String(TOOL_PORT),
						},
						stdio: ["ignore", "pipe", "pipe"],
					},
				);

				// Pipe daemon output to test console for debugging.
				daemonProc.stdout?.on("data", (d: Buffer) => {
					process.stdout.write(`[daemon] ${d.toString()}`);
				});
				daemonProc.stderr?.on("data", (d: Buffer) => {
					process.stderr.write(`[daemon:err] ${d.toString()}`);
				});

				// ── Wait for the monitor server to be ready ──────────────────────
				await waitForHttp(
					`http://localhost:${MONITOR_PORT}/status`,
					30_000,
				);
				console.log("[test] Monitor server ready");

				// ── Release the start gate ───────────────────────────────────────
				await fetch(`http://localhost:${MONITOR_PORT}/start`, { method: "POST" });
				console.log("[test] Daemon started (POST /start)");

				// Give the workspace provision a moment to complete before posting.
				await new Promise((r) => setTimeout(r, 3_000));

				// ── Post task to agent ───────────────────────────────────────────
				const taskBody = [
					`Please submit a background job using submit-job.sh.`,
					``,
					`Run this command (SHARED_DIR is already set in your environment):`,
					``,
					`  SHARED_DIR=${sharedDir} bash ${submitJobScript} \\`,
					`    --script ${jobScriptPath} \\`,
					`    --agent data-researcher \\`,
					`    --notify-subject "test-background-job-done"`,
					``,
					`After submitting the job, PostMessage me (user) to confirm`,
					`it was submitted successfully.`,
					``,
					`When you later receive the "test-background-job-done" notification`,
					`from the scheduler, or a "test-job-via-token" message from any sender,`,
					`PostMessage me (user) with the notification details.`,
				].join("\n");

				await mailboxRepo.post({
					missionId: MISSION_ID,
					from: "user",
					to: ["data-researcher"],
					subject: "Background job test",
					body: taskBody,
				});
				console.log("[test] Task posted to agent");

				// ── Wait for the agent to confirm submission (first user message) ─
				console.log("[test] Waiting for agent to confirm job submission…");
				await waitForUserMessage(db, MISSION_ID, 180_000);
				console.log("[test] Agent confirmed submission");

				// ── Wait for the job-ran marker (daemon ran the script) ──────────
				console.log("[test] Waiting for job marker file (heartbeat ≤60s)…");
				const markerDeadline = Date.now() + 90_000;
				while (!existsSync(MARKER_FILE) && Date.now() < markerDeadline) {
					await new Promise((r) => setTimeout(r, 2_000));
				}
				expect(existsSync(MARKER_FILE), "job marker file must exist — script ran").toBe(true);
				console.log("[test] Job marker file found");

				// ── Wait for the magi-tool post-message (MAGI_TOOL_TOKEN worked) ─
				console.log("[test] Waiting for magi-tool post-message (MAGI_TOOL_TOKEN test)…");
				const tokenMsg = await waitForMailboxSubject(
					db, MISSION_ID, "test-job-via-token", 30_000,
				);
				expect(tokenMsg, "magi-tool must have posted message via MAGI_TOOL_TOKEN").toBeTruthy();
				console.log("[test] MAGI_TOOL_TOKEN verified");

				// ── Wait for job status file ─────────────────────────────────────
				const statusDir = join(sharedDir, "jobs", "status");
				const statusDeadline = Date.now() + 15_000;
				let statusFile: string | null = null;
				while (!statusFile && Date.now() < statusDeadline) {
					try {
						const files = (await import("node:fs")).readdirSync(statusDir)
							.filter((f: string) => f.endsWith(".json"));
						if (files.length > 0) statusFile = join(statusDir, files[0]);
					} catch { /* dir not yet created */ }
					if (!statusFile) await new Promise((r) => setTimeout(r, 1_000));
				}
				expect(statusFile, "job status file must exist").not.toBeNull();
				const status = JSON.parse(
					(await import("node:fs")).readFileSync(statusFile!, "utf-8"),
				) as { exitCode: number };
				expect(status.exitCode, "job must have exited 0").toBe(0);
				console.log(`[test] Job status: exitCode=${status.exitCode}`);

				// ── Wait for agent's second cycle report ─────────────────────────
				console.log("[test] Waiting for agent second-cycle report…");
				const secondMsgDeadline = Date.now() + 90_000;
				let userMsgCount = 0;
				while (userMsgCount < 2 && Date.now() < secondMsgDeadline) {
					userMsgCount = await db
						.collection("mailbox")
						.countDocuments({ missionId: MISSION_ID, to: { $in: ["user"] } });
					if (userMsgCount < 2) await new Promise((r) => setTimeout(r, 2_000));
				}
				expect(
					userMsgCount,
					"agent must send at least 2 messages to user (submit confirm + job result)",
				).toBeGreaterThanOrEqual(2);

				console.log("\n[test] All assertions passed.");

			} finally {
				// ── Shut down the daemon ─────────────────────────────────────────
				if (daemonProc) {
					daemonProc.kill("SIGTERM");
					await new Promise<void>((resolve) => {
						daemonProc!.on("close", () => resolve());
						setTimeout(resolve, 5_000); // force-resolve after 5s
					});
					daemonProc = null;
				}
				await client.close();
			}
		},
		8 * 60 * 1_000, // 8 minutes
	);
});
