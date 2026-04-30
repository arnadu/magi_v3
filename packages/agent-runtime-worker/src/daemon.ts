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
 *   MONITOR_PORT       optional — dashboard HTTP port (default: 4000; must be 1–65535)
 *   TOOL_PORT          optional — Tool API server port for background jobs (default: 4001; must be 1–65535)
 *   MAX_COST_USD       optional — spending cap in USD; pauses when reached
 */

import { execSync, spawn } from "node:child_process";
import { appendFileSync, createWriteStream, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTeamConfig, type TeamConfig } from "@magi/agent-config";

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
import { createMongoConversationRepository } from "./conversation-repository.js";
import { createMongoLlmCallLogRepository } from "./llm-call-log.js";
import type { MailboxRepository } from "./mailbox.js";
import { createMongoMailboxRepository } from "./mailbox.js";
import { CLAUDE_HAIKU, CLAUDE_SONNET, parseModel } from "./models.js";
import { connectMongo } from "./mongo.js";
import { MonitorServer, type PlaybookEntry } from "./monitor-server.js";
import { runOrchestrationLoop } from "./orchestrator.js";
import { ToolApiServer } from "./tool-api-server.js";
import type { AclPolicy } from "./tools.js";
import { UsageAccumulator } from "./usage.js";
import type { AgentIdentity } from "./workspace-manager.js";
import { WorkspaceManager } from "./workspace-manager.js";

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------

/**
 * A background job to run via sudo as the agent's linux user.
 * Written to sharedDir/jobs/pending/<id>.json by schedule files (jobSpec field)
 * or directly by submit-job.sh / the agent.
 *
 * NOTE: linuxUser is intentionally absent. The daemon derives it from agentId
 * via the team config at execution time, preventing a compromised agent from
 * escalating privileges by writing an arbitrary linuxUser into the spec file.
 */
interface JobSpec {
	/** Unique job id (UUID). */
	id: string;
	/** Agent whose linuxUser and ACL the job runs under. */
	agentId: string;
	/** Absolute path to the script (shebang selects interpreter). */
	scriptPath: string;
	/** Positional arguments passed after scriptPath. */
	args: string[];
	/** If set, post a mailbox message to this agent on completion. */
	notifyAgentId?: string;
	/** Subject for the completion notification. */
	notifySubject?: string;
	/**
	 * Wall-clock timeout in milliseconds (F-006).
	 * The job process (and its entire process group) is killed after this delay.
	 * Default: 30 minutes.
	 */
	timeoutMs?: number;
}

/** Default job wall-clock timeout: 30 minutes (F-006). */
const DEFAULT_JOB_TIMEOUT_MS = 30 * 60_000;


// ---------------------------------------------------------------------------
// Background job execution
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_JOBS = 3;
/** Track running jobs so we enforce the concurrency limit. */
let runningJobs = 0;

/**
 * Scan sharedDir/jobs/pending/*.json and spawn each job (up to
 * MAX_CONCURRENT_JOBS at a time).
 *
 * Job files are written by:
 *   - The scheduled delivery heartbeat (when a cron spec has a jobSpec field).
 *   - submit-job.sh (agent or operator one-shots).
 *
 * For each pending job:
 *   1. Move the spec to jobs/running/ (atomically prevents double-execution).
 *   2. Issue a bearer token for the agent's ACL.
 *   3. Spawn: sudo -u <linuxUser> <scriptPath> <args...>
 *      with MAGI_TOOL_URL, MAGI_TOOL_TOKEN, data-key env vars, PATH, HOME.
 *   4. Pipe stdout+stderr to logs/bg-<id>.log.
 *   5. On exit: revoke token, write jobs/status/<id>.json, optionally notify.
 */
/**
 * F-010: On daemon startup, jobs left in jobs/running/ from a previous run have
 * no live token — their magi-tool calls will fail with 401. Move them back to
 * pending/ so they are retried with a fresh token on the next heartbeat.
 */
function recoverOrphanedJobs(sharedDir: string): void {
	const runningDir = join(sharedDir, "jobs", "running");
	const pendingDir = join(sharedDir, "jobs", "pending");
	let files: string[];
	try {
		files = readdirSync(runningDir).filter((f) => f.endsWith(".json"));
	} catch {
		return; // running dir does not exist yet — nothing to recover
	}
	if (files.length === 0) return;
	mkdirSync(pendingDir, { recursive: true });
	for (const file of files) {
		const src = join(runningDir, file);
		const dst = join(pendingDir, file);
		try {
			writeFileSync(dst, readFileSync(src));
			unlinkSync(src);
			console.log(`[daemon:jobs] Recovered orphaned job: ${file}`);
		} catch (e) {
			console.error(`[daemon:jobs] Failed to recover ${file}: ${(e as Error).message}`);
		}
	}
}

async function runPendingJobs(
	sharedDir: string,
	workdir: string,
	missionId: string,
	toolApiServer: ToolApiServer,
	toolPort: number,
	mailboxRepo: MailboxRepository,
	teamConfig: TeamConfig,
): Promise<void> {
	const pendingDir = join(sharedDir, "jobs", "pending");
	const runningDir = join(sharedDir, "jobs", "running");
	const statusDir  = join(sharedDir, "jobs", "status");
	const logsDir    = join(sharedDir, "logs");

	let files: string[];
	try {
		files = readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
	} catch {
		return; // pending dir does not exist yet
	}

	for (const file of files) {
		if (runningJobs >= MAX_CONCURRENT_JOBS) break;

		const pendingPath = join(pendingDir, file);
		let spec: JobSpec;
		try {
			spec = JSON.parse(readFileSync(pendingPath, "utf8")) as JobSpec;
		} catch {
			continue; // malformed spec — leave it for the next cycle
		}

		// Atomically claim the job: move pending → running.
		const runningPath = join(runningDir, file);
		try {
			mkdirSync(runningDir, { recursive: true });
			mkdirSync(statusDir, { recursive: true });
			mkdirSync(logsDir, { recursive: true });
			// Node doesn't expose atomic rename across directories natively,
			// but writeFileSync + unlinkSync is safe enough for our use case
			// (single-process daemon, not distributed).
			writeFileSync(runningPath, readFileSync(pendingPath));
			unlinkSync(pendingPath);
		} catch {
			continue; // race or IO error — skip
		}

		// Derive linuxUser from the team config — never trust the job file.
		const agentCfg = teamConfig.agents.find((a) => a.id === spec.agentId);
		if (!agentCfg) {
			console.error(
				`[daemon:jobs] Unknown agentId "${spec.agentId}" in job ${spec.id} — skipping`,
			);
			try { unlinkSync(runningPath); } catch {}
			continue;
		}
		const linuxUser = agentCfg.linuxUser ?? agentCfg.id;
		const agentWorkdir = join(workdir, "home", linuxUser, "missions", missionId);
		const permittedPaths = [agentWorkdir, sharedDir];

		// F-013: Validate scriptPath using resolve() + realpathSync() to prevent
		// symlink traversal (an agent could symlink a script inside permittedPaths
		// to an arbitrary executable outside them).
		let resolvedScript: string;
		try {
			resolvedScript = resolve(spec.scriptPath);
			const realScript = realpathSync(resolvedScript);
			const scriptAllowed = permittedPaths.some(
				(p) => realScript === p || realScript.startsWith(p + "/"),
			);
			if (!scriptAllowed) {
				console.error(
					`[daemon:jobs] scriptPath "${spec.scriptPath}" resolves outside permitted paths for agent "${spec.agentId}" — skipping`,
				);
				try { unlinkSync(runningPath); } catch {}
				continue;
			}
		} catch (e) {
			console.error(
				`[daemon:jobs] scriptPath "${spec.scriptPath}" could not be resolved: ${(e as Error).message} — skipping`,
			);
			try { unlinkSync(runningPath); } catch {}
			continue;
		}

		const acl: AclPolicy = {
			agentId: spec.agentId,
			linuxUser,
			permittedPaths,
		};
		const identity: AgentIdentity = {
			workdir: agentWorkdir,
			sharedDir,
			linuxUser,
		};

		// F-014: Issue token just before spawn — revoke immediately if spawn fails
		// so the token window is as short as possible.
		const token = toolApiServer.issueToken(acl, identity);
		const logPath = join(logsDir, `bg-${spec.id}.log`);
		const logStream = createWriteStream(logPath, { flags: "a" });

		runningJobs++;
		console.log(`[daemon:jobs] Starting job ${spec.id} (${spec.scriptPath}) as ${linuxUser}`);

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(
				"sudo",
				["-u", linuxUser, "/usr/local/bin/magi-job", resolvedScript, ...spec.args],
				{
					env: {
						PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
						HOME: `/home/${linuxUser}`,
						MAGI_TOOL_URL: `http://127.0.0.1:${toolPort}`,
						MAGI_TOOL_TOKEN: token,
						...dataKeysEnv(),
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
		} catch (e) {
			// F-014: spawn failed — revoke token immediately so it cannot be used.
			runningJobs--;
			toolApiServer.revokeToken(token);
			logStream.end();
			try { unlinkSync(runningPath); } catch {}
			console.error(`[daemon:jobs] Failed to spawn job ${spec.id}: ${(e as Error).message}`);
			continue;
		}

		child.stdout?.pipe(logStream);
		child.stderr?.pipe(logStream);

		// F-006: Wall-clock timeout — kill the entire process group after timeoutMs.
		const jobTimeoutMs = spec.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
		const timeoutHandle = setTimeout(() => {
			console.error(`[daemon:jobs] Job ${spec.id} timed out after ${jobTimeoutMs}ms — killing`);
			if (child.pid !== undefined) {
				try { process.kill(-child.pid, "SIGKILL"); } catch {}
			} else {
				child.kill("SIGKILL");
			}
		}, jobTimeoutMs);

		child.on("close", (exitCode) => {
			clearTimeout(timeoutHandle);
			runningJobs--;
			toolApiServer.revokeToken(token);
			logStream.end();

			// Clean up the running file.
			try { unlinkSync(runningPath); } catch {}

			// Write status file.
			const statusPath = join(statusDir, `${spec.id}.json`);
			const status = {
				id: spec.id,
				scriptPath: spec.scriptPath,
				exitCode: exitCode ?? -1,
				completedAt: new Date().toISOString(),
				logPath,
			};
			try { writeFileSync(statusPath, JSON.stringify(status, null, 2)); } catch {}

			const success = exitCode === 0;
			console.log(
				`[daemon:jobs] Job ${spec.id} exited ${exitCode ?? "null"} — ${success ? "ok" : "FAILED"}`,
			);

			// Post completion notification if requested.
			if (spec.notifyAgentId) {
				const subject = spec.notifySubject ?? `Background job complete: ${spec.id}`;
				const body = success
					? `Job completed successfully.\nLog: ${logPath}`
					: `Job FAILED (exit ${exitCode ?? "null"}).\nLog: ${logPath}`;
				mailboxRepo
					.post({
						missionId,
						from: "scheduler",
						to: [spec.notifyAgentId],
						subject,
						body,
					})
					.catch((e: unknown) =>
						console.error(`[daemon:jobs] Failed to notify ${spec.notifyAgentId}: ${(e as Error).message}`),
					);
			}
		});
	}
}

// ---------------------------------------------------------------------------
// Background job runner
// ---------------------------------------------------------------------------

/**
 * Start a heartbeat that checks for pending background jobs every minute.
 * Scheduled message delivery has moved to the control plane (Sprint 14);
 * the daemon only handles job files written directly to jobs/pending/ by
 * agents (submit-job.sh) or by the control plane's scheduler.
 *
 * Returns a cleanup function that stops the interval.
 */
function startJobRunner(
	sharedDir: string,
	workdir: string,
	missionId: string,
	toolApiServer: ToolApiServer,
	toolPort: number,
	mailboxRepo: MailboxRepository,
	teamConfig: TeamConfig,
): () => void {
	function tick(): void {
		runPendingJobs(sharedDir, workdir, missionId, toolApiServer, toolPort, mailboxRepo, teamConfig)
			.catch((e) => console.error("[daemon:jobs] Heartbeat error:", e));
	}

	// Run any pending jobs immediately on startup (handles crash recovery).
	tick();

	const handle = setInterval(tick, 60_000);
	return () => clearInterval(handle);
}

// ---------------------------------------------------------------------------
// OS user provisioning (production Docker)
// ---------------------------------------------------------------------------

/**
 * Ensure every agent in the team config has a corresponding Linux OS user.
 *
 * In dev/test environments, pool users (magi-w1..magi-w5) are created by
 * setup-dev.sh and already exist — execSync("id ...") succeeds and this
 * function is a no-op for each such agent.
 *
 * In production Docker, agents omit linuxUser and the username defaults to
 * agent.id. The Dockerfile only creates the magi-shared group; this function
 * creates per-agent OS users at first startup.
 *
 * Idempotent: if the user already exists, the step is skipped silently.
 */
function ensureAgentUsers(agents: Array<{ id: string; linuxUser?: string }>): void {
	for (const agent of agents) {
		const linuxUser = agent.linuxUser ?? agent.id;
		try {
			execSync(`id ${linuxUser}`, { stdio: "ignore" });
		} catch {
			// User does not exist — create it.
			try {
				execSync(
					`useradd -m -s /bin/bash -G magi-shared ${linuxUser}`,
					{ stdio: "inherit" },
				);
				// Append a NOPASSWD sudo rule for the magi-node and magi-job wrappers.
				appendFileSync(
					"/etc/sudoers.d/magi",
					`${linuxUser} ALL=(ALL) NOPASSWD: /usr/local/bin/magi-node\n` +
					`${linuxUser} ALL=(ALL) NOPASSWD: /usr/local/bin/magi-job\n`,
				);
				console.log(`[daemon] Created OS user: ${linuxUser}`);
			} catch (e) {
				// Non-fatal: in non-root dev environments, useradd requires root.
				// The pool users already exist so this path is only hit in Docker.
				console.warn(`[daemon] Could not create OS user ${linuxUser}: ${(e as Error).message}`);
			}
		}
	}
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
	// Synchronous write so the line is never lost if the process exits immediately.
	process.stdout.write("[daemon] Starting up…\n");

	const teamConfigPath = process.env.TEAM_CONFIG;
	const mongoUri = process.env.MONGODB_URI;

	process.stdout.write(`[daemon] TEAM_CONFIG=${teamConfigPath ?? "(unset)"}\n`);
	process.stdout.write(`[daemon] MONGODB_URI=${mongoUri ? "(set)" : "(unset)"}\n`);
	process.stdout.write(`[daemon] ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? "(set)" : "(unset)"}\n`);

	if (!teamConfigPath || !mongoUri) {
		process.stderr.write("Error: TEAM_CONFIG and MONGODB_URI are required\n");
		process.exitCode = 1;
		return;
	}
	if (!process.env.ANTHROPIC_API_KEY) {
		process.stderr.write("Error: ANTHROPIC_API_KEY is required\n");
		process.exitCode = 1;
		return;
	}

	process.stdout.write("[daemon] Loading team config…\n");
	const teamConfig = loadTeamConfig(teamConfigPath);
	const missionId = teamConfig.mission.id;
	process.stdout.write(`[daemon] Mission: ${missionId} (${teamConfig.agents.length} agents)\n`);

	// Ensure every agent has a Linux OS user. No-op for existing pool users
	// (dev/test); creates per-agent users in production Docker.
	process.stdout.write("[daemon] Ensuring agent OS users…\n");
	ensureAgentUsers(teamConfig.agents);

	process.stdout.write("[daemon] Connecting to MongoDB…\n");
	const { client, db } = await connectMongo(mongoUri);
	process.stdout.write("[daemon] MongoDB connected.\n");

	const mailboxRepo = createMongoMailboxRepository(db, missionId);
	const conversationRepo = createMongoConversationRepository(db);
	const llmCallLog = createMongoLlmCallLogRepository(db);

	const modelId = process.env.MODEL ?? "claude-sonnet-4-6";
	const model =
		modelId === "claude-sonnet-4-6" ? CLAUDE_SONNET : parseModel(modelId);

	const visionModelId = process.env.VISION_MODEL ?? "claude-haiku-4-5-20251001";
	const visionModel =
		visionModelId === "claude-haiku-4-5-20251001" ? CLAUDE_HAIKU
		: visionModelId === "claude-sonnet-4-6" ? CLAUDE_SONNET
		: parseModel(visionModelId);

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
		platformSkillsPath: join(REPO_ROOT, "packages", "skills"),
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

	const toolPort = Number.parseInt(process.env.TOOL_PORT ?? "4001", 10);
	if (!Number.isFinite(toolPort) || toolPort < 1 || toolPort > 65535) {
		console.error(
			`Error: TOOL_PORT must be 1–65535, got: ${process.env.TOOL_PORT}`,
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
	process.stdout.write(`[daemon] Monitor server listening on port ${monitorPort}\n`);

	// Tool API server — exposes LLM tools to background job scripts.
	const toolApiServer = new ToolApiServer(
		model,
		visionModel,
		join(workdir, "missions", missionId, "shared"),
		mailboxRepo,
		teamConfig,
	);
	toolApiServer.listen(toolPort);

	const sharedDir = join(workdir, "missions", missionId, "shared");

	// F-010: Recover jobs that were left in running/ by a prior daemon run.
	// They have no live token, so their magi-tool calls would fail with 401.
	// Moving them back to pending/ allows the next heartbeat to retry them.
	recoverOrphanedJobs(sharedDir);
	// Scheduled message delivery has moved to the control plane (Sprint 14).
	// The daemon only runs background job files written to jobs/pending/.
	const stopJobRunner = startJobRunner(
		sharedDir,
		workdir,
		missionId,
		toolApiServer,
		toolPort,
		mailboxRepo,
		teamConfig,
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
		toolApiServer.stop();
		stopJobRunner();
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
	// Synchronous write — async stderr can be lost if process.exit() fires first.
	process.stderr.write(`[daemon] Fatal error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
	process.exitCode = 1;
});
