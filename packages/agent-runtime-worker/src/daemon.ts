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

// Load .env from the repo root (two levels up from packages/agent-runtime-worker/).
dotenvConfig({
	path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env"),
	quiet: true,
});

import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
	Usage,
} from "@mariozechner/pi-ai";
import type { Collection } from "mongodb";
import { schedule } from "node-cron";
import { createMongoConversationRepository } from "./conversation-repository.js";
import type { MailboxRepository } from "./mailbox.js";
import { createMongoMailboxRepository } from "./mailbox.js";
import { createMongoMentalMapRepository, initMentalMap } from "./mental-map.js";
import { anthropicModel, CLAUDE_SONNET } from "./models.js";
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
		for (const block of (msg as AssistantMessage).content) {
			if (block.type === "text" && block.text.trim()) {
				console.log(`  [${speaker}] ${block.text.trim()}`);
			} else if (block.type === "toolCall") {
				const args = JSON.stringify(block.arguments);
				const preview = args.length > 120 ? `${args.slice(0, 120)}…` : args;
				console.log(`  [${speaker}] → ${block.name}(${preview})`);
			}
		}
	} else {
		const tr = msg as ToolResultMessage;
		const text = tr.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("")
			.trim();
		const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
		console.log(`  [${speaker}] ← ${tr.toolName}: ${preview}`);
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
	const mentalMapRepo = createMongoMentalMapRepository(db);
	const conversationRepo = createMongoConversationRepository(db);

	const modelId = process.env.MODEL ?? "claude-sonnet-4-6";
	const model =
		modelId === "claude-sonnet-4-6" ? CLAUDE_SONNET : anthropicModel(modelId);

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
	process.on("SIGTERM", () => ac.abort());
	process.on("SIGINT", () => {
		console.log("\n[daemon] Interrupted — shutting down...");
		ac.abort();
	});

	// PID file — enables cli:stop and external process management.
	const missionDir = join(workdir, "missions", missionId);
	mkdirSync(missionDir, { recursive: true });
	const pidFile = join(missionDir, "daemon.pid");
	writeFileSync(pidFile, String(process.pid));

	// Usage accumulator + optional spending cap.
	const usageAccumulator = new UsageAccumulator();
	const maxCostUsd = process.env.MAX_COST_USD
		? Number.parseFloat(process.env.MAX_COST_USD)
		: null;
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

	// Seed initial mental maps so the dashboard shows them before Start is clicked.
	for (const agent of teamConfig.agents) {
		const existing = await mentalMapRepo.load(agent.id);
		if (!existing) {
			await mentalMapRepo.save(agent.id, initMentalMap(agent));
		}
	}

	console.log(`[daemon] Mission: ${teamConfig.mission.name} (${missionId})`);
	console.log(
		`[daemon] Dashboard: http://localhost:${monitorPort} — click ▶ Start to begin`,
	);

	// Block until the operator clicks Start in the dashboard.
	await monitor.waitForStart();
	console.log("[daemon] Mission started — entering orchestration loop");

	try {
		await runOrchestrationLoop(
			{
				teamConfig,
				mailboxRepo,
				mentalMapRepo,
				conversationRepo,
				model,
				workdir,
				workspaceManager,
				waitForMail,
				waitForStep: () => monitor.waitForStep(),
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
							console.error(
								`[daemon] Spending cap $${maxCostUsd.toFixed(2)} reached — aborting`,
							);
							monitor.push("cost-limit", {
								limitUsd: maxCostUsd,
								totalUsd: usageAccumulator.totalCostUsd(),
							});
							ac.abort();
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
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
