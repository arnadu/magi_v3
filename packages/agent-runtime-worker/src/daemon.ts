#!/usr/bin/env node

/**
 * Persistent daemon entry point for MAGI V3 agent teams.
 *
 * Unlike cli.ts (which runs once and exits), the daemon sleeps on a MongoDB
 * Change Stream when the inbox is empty and wakes when a new message is
 * inserted. Use cli:post to inject messages and cli:tail to watch replies.
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY  required
 *   MONGODB_URI        required
 *   TEAM_CONFIG        required — path to team config YAML
 *   MODEL              optional — model id (default: claude-sonnet-4-6)
 *   VISION_MODEL       optional — model for image captioning / BrowseWeb (default: claude-haiku-4-5-20251001)
 *   AGENT_WORKDIR      optional — working directory (default: cwd)
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTeamConfig } from "@magi/agent-config";
import cronParser from "cron-parser";

const { parseExpression } = cronParser;

import { config as dotenvConfig } from "dotenv";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Load orchestrator secrets (.env) — NEVER forwarded to agent subprocesses.
dotenvConfig({ path: join(REPO_ROOT, ".env"), quiet: true });

// Load data API keys (.env.data-keys) — forwarded to background jobs only.
// Kept in a separate file so the forwarding boundary is explicit and auditable.
dotenvConfig({ path: join(REPO_ROOT, ".env.data-keys"), quiet: true });

/**
 * Environment variables from .env.data-keys that are safe to forward to
 * background job subprocesses (refresh.py, adapters, etc.).
 * These keys only authorize calls to external data APIs; they have no
 * privilege over the MAGI system itself.
 */
export const DATA_KEY_NAMES = ["FRED_API_KEY", "FMP_API_KEY", "NEWSAPIORG_API_KEY"] as const;

/**
 * Build the env block to pass when spawning a background job.
 * Includes only DATA_KEY_NAMES that are actually set — missing keys are omitted
 * rather than forwarded as empty strings, so adapters see a clean "not set" error.
 */
export function dataKeysEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of DATA_KEY_NAMES) {
		const val = process.env[key];
		if (val) env[key] = val;
	}
	return env;
}

import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
	Usage,
} from "@mariozechner/pi-ai";
import type { Collection } from "mongodb";
import { schedule } from "node-cron";
import { createMongoConversationRepository } from "./conversation-repository.js";
import { createMongoLlmCallLogRepository } from "./llm-call-log.js";
import type { MailboxRepository } from "./mailbox.js";
import { createMongoMailboxRepository } from "./mailbox.js";
import { anthropicModel, CLAUDE_HAIKU, CLAUDE_SONNET } from "./models.js";
import { connectMongo } from "./mongo.js";
import { MonitorServer, type PlaybookEntry } from "./monitor-server.js";
import { runOrchestrationLoop } from "./orchestrator.js";
import { UsageAccumulator } from "./usage.js";
import { WorkspaceManager } from "./workspace-manager.js";

// ---------------------------------------------------------------------------
// Scheduled message delivery
// ---------------------------------------------------------------------------

interface ScheduledMessageDoc {
	_id: unknown;
	missionId: string;
	to: string[];
	subject: string;
	body: string;
	deliverAt: Date;
	cron?: string;
	label?: string;
	status: "pending" | "delivered" | "cancelled";
}

// ---------------------------------------------------------------------------
// Schedule file import
// ---------------------------------------------------------------------------

interface ScheduleSpec {
	label: string;
	to: string[];
	cron: string;
	subject: string;
	body: string;
}

/**
 * Scan sharedDir/schedules/*.json and upsert each entry into the
 * scheduled_messages collection. Called on startup and on each heartbeat.
 * Re-running with the same label updates the schedule (idempotent).
 */
async function importScheduleFiles(
	schedulesDir: string,
	col: Collection<ScheduledMessageDoc>,
	missionId: string,
): Promise<void> {
	let files: string[];
	try {
		files = readdirSync(schedulesDir).filter((f) => f.endsWith(".json"));
	} catch {
		return; // schedules dir does not exist yet — nothing to import
	}
	for (const file of files) {
		try {
			const raw = readFileSync(join(schedulesDir, file), "utf8");
			const spec = JSON.parse(raw) as ScheduleSpec;
			const next = parseExpression(spec.cron).next().toDate();
			await col.updateOne(
				{ missionId, label: spec.label },
				{
					$set: {
						missionId,
						to: spec.to,
						subject: spec.subject,
						body: spec.body,
						cron: spec.cron,
						label: spec.label,
						deliverAt: next,
						status: "pending",
					},
				},
				{ upsert: true },
			);
			console.log(
				`[daemon:scheduler] Schedule imported: ${spec.label} → next at ${next.toISOString()}`,
			);
		} catch (e) {
			console.error(
				`[daemon:scheduler] Failed to import ${file}: ${(e as Error).message}`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Scheduled delivery
// ---------------------------------------------------------------------------

function startScheduledDelivery(
	col: Collection<ScheduledMessageDoc>,
	mailboxRepo: MailboxRepository,
	missionId: string,
	schedulesDir: string,
): () => void {
	async function deliver(): Promise<void> {
		// Import any new or updated schedule files first.
		await importScheduleFiles(schedulesDir, col, missionId);

		const now = new Date();
		// Atomically claim each pending message before delivering — prevents
		// double-delivery if two daemon instances run concurrently or the process
		// restarts mid-delivery.
		while (true) {
			const doc = await col.findOneAndUpdate(
				{ missionId, status: "pending", deliverAt: { $lte: now } },
				{ $set: { status: "delivered" } },
			);
			if (!doc) break;
			await mailboxRepo.post({
				missionId: doc.missionId,
				from: "scheduler",
				to: doc.to,
				subject: doc.subject,
				body: doc.body,
			});
			console.log(
				`[daemon:scheduler] Delivered scheduled message to: ${doc.to.join(", ")}`,
			);
			// Re-arm cron-based entries so the schedule recurs.
			if (doc.cron) {
				try {
					const next = parseExpression(doc.cron).next().toDate();
					await col.updateOne(
						{ _id: doc._id },
						{ $set: { status: "pending", deliverAt: next } },
					);
					console.log(
						`[daemon:scheduler] Re-armed ${doc.label ?? "entry"} → next at ${next.toISOString()}`,
					);
				} catch (e) {
					console.error(
						`[daemon:scheduler] Failed to re-arm cron entry: ${(e as Error).message}`,
					);
				}
			}
		}
	}

	// Deliver any overdue messages immediately on startup (crash recovery).
	deliver().catch((e) => console.error("[daemon:scheduler] Error:", e));

	// Heartbeat every minute.
	const task = schedule("* * * * *", () =>
		deliver().catch((e) => console.error("[daemon:scheduler] Error:", e)),
	);

	return () => task.stop();
}

// ---------------------------------------------------------------------------
// Message logging
// ---------------------------------------------------------------------------

function logMessage(msg: Message, agentId?: string): void {
	if (msg.role === "user") return;
	const speaker = agentId ?? "assistant";
	if (msg.role === "assistant") {
		const am = msg as AssistantMessage;
		if (am.stopReason === "error" || am.stopReason === "aborted") {
			console.error(
				`  [${speaker}] ✗ LLM error (${am.stopReason}): ${am.errorMessage ?? "(no message)"}`,
			);
		}
		for (const block of am.content) {
			if (block.type === "text" && block.text.trim()) {
				const t = block.text.trim().replace(/\n+/g, " ");
				console.log(
					`  [${speaker}] ${t.length > 120 ? `${t.slice(0, 120)}…` : t}`,
				);
			} else if (block.type === "toolCall") {
				// Full detail for PostMessage (key inter-agent event); compact one-liner for the rest.
				if (block.name === "PostMessage") {
					const args = block.arguments as { to?: unknown; subject?: unknown };
					const to = Array.isArray(args.to)
						? (args.to as string[]).join(", ")
						: String(args.to ?? "?");
					const subject = String(args.subject ?? "(no subject)");
					console.log(`  [${speaker}] → PostMessage to:${to} "${subject}"`);
				} else {
					// First key=value pair as a terse hint.
					const entries = Object.entries(
						block.arguments as Record<string, unknown>,
					);
					const hint =
						entries.length > 0
							? ` ${String(entries[0][1] ?? "")
									.replace(/\n+/g, " ")
									.slice(0, 60)}`
							: "";
					console.log(`  [${speaker}] → ${block.name}${hint}`);
				}
			}
		}
	} else {
		const tr = msg as ToolResultMessage;
		if (tr.isError) {
			const text = tr.content
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("")
				.trim()
				.replace(/\n+/g, " ");
			const preview = text.length > 100 ? `${text.slice(0, 100)}…` : text;
			console.error(`  [${speaker}] ✗ ${tr.toolName}: ${preview}`);
		} else {
			console.log(`  [${speaker}] ← ${tr.toolName} ok`);
		}
	}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const teamConfigPath = process.env.TEAM_CONFIG;
	const mongoUri = process.env.MONGODB_URI;

	if (!teamConfigPath || !mongoUri) {
		console.error("Error: TEAM_CONFIG and MONGODB_URI are required");
		process.exit(1);
	}
	if (!process.env.ANTHROPIC_API_KEY) {
		console.error("Error: ANTHROPIC_API_KEY is required");
		process.exit(1);
	}

	const teamConfig = loadTeamConfig(teamConfigPath);
	const missionId = teamConfig.mission.id;
	const { client, db } = await connectMongo(mongoUri);

	const mailboxRepo = createMongoMailboxRepository(db, missionId);
	const conversationRepo = createMongoConversationRepository(db);
	const llmCallLog = createMongoLlmCallLogRepository(db);

	const modelId = process.env.MODEL ?? "claude-sonnet-4-6";
	const model =
		modelId === "claude-sonnet-4-6" ? CLAUDE_SONNET : anthropicModel(modelId);

	const visionModelId = process.env.VISION_MODEL ?? "claude-haiku-4-5-20251001";
	const visionModel =
		visionModelId === "claude-haiku-4-5-20251001" ? CLAUDE_HAIKU
		: visionModelId === "claude-sonnet-4-6" ? CLAUDE_SONNET
		: anthropicModel(visionModelId);

	const workdir = process.env.AGENT_WORKDIR ?? process.cwd();
	const teamSkillsPath = join(
		dirname(teamConfigPath),
		basename(teamConfigPath, ".yaml"),
		"skills",
	);
	const workspaceManager = new WorkspaceManager({
		layout: {
			homeBase: join(workdir, "home"),
			missionsBase: join(workdir, "missions"),
		},
		teamSkillsPath,
	});

	// Abort controller — fired by SIGTERM / SIGINT / cost cap / monitor stop.
	const ac = new AbortController();
	const { signal } = ac;
	let shutdownInitiated = false;
	function initiateShutdown(reason: string): void {
		if (shutdownInitiated) {
			// Second signal — force exit immediately.
			console.log("\n[daemon] Force exit");
			process.exit(1);
		}
		shutdownInitiated = true;
		console.log(`\n[daemon] ${reason} — shutting down… (Ctrl-C again to force)`);
		ac.abort();
	}
	process.on("SIGTERM", () => initiateShutdown("SIGTERM"));
	process.on("SIGINT",  () => initiateShutdown("Interrupted"));

	// PID file — enables cli:stop and guards against duplicate daemons.
	const missionDir = join(workdir, "missions", missionId);
	mkdirSync(missionDir, { recursive: true });
	const pidFile = join(missionDir, "daemon.pid");

	// Check for a running instance before writing our own PID.
	try {
		const existingPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
		if (!Number.isNaN(existingPid) && existingPid !== process.pid) {
			try {
				// Signal 0 tests liveness without sending a real signal.
				process.kill(existingPid, 0);
				// If we reach here the process is alive — refuse to start.
				console.error(
					`[daemon] Already running as PID ${existingPid} (mission: ${missionId}).`,
				);
				console.error(
					`[daemon] Run: MISSION_ID=${missionId} npm run cli:stop`,
				);
				process.exit(1);
			} catch {
				// ESRCH — process is gone; stale PID file, safe to continue.
				console.warn(
					`[daemon] Stale PID file (PID ${existingPid} not found) — starting fresh.`,
				);
			}
		}
	} catch {
		// PID file missing or unreadable — first start, proceed normally.
	}

	writeFileSync(pidFile, String(process.pid));

	// Usage accumulator + optional spending cap.
	const usageAccumulator = new UsageAccumulator();
	let maxCostUsd = (() => {
		if (!process.env.MAX_COST_USD) return null;
		const v = Number.parseFloat(process.env.MAX_COST_USD);
		if (!Number.isFinite(v) || v <= 0) {
			console.error(
				`Error: MAX_COST_USD must be a positive number, got: ${process.env.MAX_COST_USD}`,
			);
			process.exit(1);
		}
		return v;
	})();
	if (maxCostUsd !== null) {
		console.log(`[daemon] Spending cap: $${maxCostUsd.toFixed(2)}`);
	}

	// Monitor server — SSE dashboard on MONITOR_PORT (default 4000).
	// Load playbook.json from the team config directory if present.
	const teamDir = join(
		dirname(teamConfigPath),
		basename(teamConfigPath, ".yaml"),
	);
	let playbook: PlaybookEntry[] = [];
	try {
		playbook = JSON.parse(
			readFileSync(join(teamDir, "playbook.json"), "utf8"),
		) as PlaybookEntry[];
	} catch {
		/* no playbook file — that's fine */
	}

	const monitorPort = Number.parseInt(process.env.MONITOR_PORT ?? "4000", 10);
	if (!Number.isFinite(monitorPort) || monitorPort < 1 || monitorPort > 65535) {
		console.error(
			`Error: MONITOR_PORT must be 1–65535, got: ${process.env.MONITOR_PORT}`,
		);
		process.exit(1);
	}
	const agents = teamConfig.agents.map((a) => ({
		id: a.id,
		name: a.name ?? a.id,
		role: a.role ?? a.id,
	}));
	const monitor = new MonitorServer(
		db,
		missionId,
		teamConfig.mission.name,
		modelId,
		usageAccumulator,
		mailboxRepo,
		agents,
		() => ac.abort(),
		maxCostUsd,
		new Date(),
		playbook,
	);
	await monitor.start(monitorPort);

	// Scheduled message delivery infrastructure.
	const scheduledCol = db.collection<ScheduledMessageDoc>("scheduled_messages");
	const sharedDir = join(workdir, "missions", missionId, "shared");
	const schedulesDir = join(sharedDir, "schedules");
	const stopScheduler = startScheduledDelivery(
		scheduledCol,
		mailboxRepo,
		missionId,
		schedulesDir,
	);

	// Change Stream: wake when a new MailboxMessage is inserted for this mission.
	const mailboxCol = db.collection("mailbox");

	// Open a single Change Stream and resolve when a matching insert arrives.
	// Rejects on stream error so the caller can retry.
	function openChangeStream(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const stream = mailboxCol.watch(
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
			stream.once("error", (err) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			});
		});
	}

	// Wraps openChangeStream with exponential backoff so a transient MongoDB
	// network error does not crash the daemon.
	async function waitForMail(): Promise<void> {
		if (signal.aborted) return;
		let backoffMs = 1_000;
		while (!signal.aborted) {
			try {
				await openChangeStream();
				return;
			} catch (e) {
				if (signal.aborted) return;
				console.error(
					`[daemon] Change Stream error: ${(e as Error).message}. Retrying in ${backoffMs}ms`,
				);
				await new Promise<void>((res) => {
					const timer = setTimeout(res, backoffMs);
					signal.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							res();
						},
						{ once: true },
					);
				});
				backoffMs = Math.min(backoffMs * 2, 30_000);
			}
		}
	}

	console.log(`[daemon] Mission: ${teamConfig.mission.name} (${missionId})`);
	console.log(
		`[daemon] Dashboard: http://localhost:${monitorPort} — click ▶ Start to begin`,
	);

	// Keep daemon's local maxCostUsd in sync when the operator extends the budget.
	monitor.onBudgetExtended = (newCapUsd) => {
		maxCostUsd = newCapUsd;
		console.log(`[daemon] Spending cap updated to $${newCapUsd.toFixed(2)}`);
	};

	// Block until the operator clicks Start in the dashboard.
	await monitor.waitForStart();
	console.log("[daemon] Mission started — entering orchestration loop");

	try {
		await runOrchestrationLoop(
			{
				teamConfig,
				mailboxRepo,
				conversationRepo,
				llmCallLog,
				model,
				visionModel,
				workdir,
				workspaceManager,
				waitForMail,
				waitForStep: () => monitor.waitForStep(),
				waitForBudget: () => monitor.waitForBudget(),
				onAgentStart: (agentId, pending) =>
					monitor.notifyAgentStart(agentId, pending),
				onAgentDone: (agentId) => monitor.notifyAgentDone(agentId),
				onIdle: () => monitor.notifyIdle(),
				onMentalMapUpdate: (agentId, html) =>
					monitor.notifyMentalMapUpdate(agentId, html),
				onAgentMessage: (agentId, msg) => {
					logMessage(msg, agentId);
					if (msg.role === "assistant") {
						const usage = (msg as AssistantMessage).usage as Usage;
						usageAccumulator.add(agentId, usage);
						console.log(usageAccumulator.callLine(agentId, usage));
						monitor.push("llm-call", {
							agentId,
							input: usage.input,
							output: usage.output,
							cacheRead: usage.cacheRead,
							callCostUsd: usage.cost.total,
							agentTotalUsd:
								usageAccumulator.agents().find((a) => a.agentId === agentId)
									?.costUsd ?? 0,
							missionTotalUsd: usageAccumulator.totalCostUsd(),
						});
						if (
							maxCostUsd !== null &&
							usageAccumulator.totalCostUsd() >= maxCostUsd
						) {
							monitor.notifyCostPause(
								usageAccumulator.totalCostUsd(),
								maxCostUsd,
							);
						}
					}
				},
			},
			signal,
		);
	} finally {
		monitor.push("shutdown", { reason: signal.aborted ? "abort" : "normal" });
		monitor.stop();
		stopScheduler();
		await client.close();
		// Clean up PID file.
		try {
			unlinkSync(pidFile);
		} catch {}
		// Print final usage roll-up.
		console.log(usageAccumulator.fullSummary());
		console.log("[daemon] Shutdown complete");
	}
	// Force-exit after cleanup. The MongoDB driver and other async handles can
	// keep the event loop alive even after client.close() — process.exit() is
	// the only reliable way to free the port and terminate cleanly.
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
