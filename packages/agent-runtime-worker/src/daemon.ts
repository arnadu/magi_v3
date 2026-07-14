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
 *   TEAM_CONFIG_YAML   optional — base64-encoded YAML; if set and TEAM_CONFIG path does not
 *                                 yet exist, written to disk on first boot (volume injection)
 *   TEAM_FILES_PAYLOAD optional — base64-encoded JSON array of {path,content} for all team
 *                                 files (skills, playbook.json, etc.); written to teamDir on
 *                                 first boot alongside TEAM_CONFIG_YAML
 *   TEAM_SKILLS_PATH   optional — override path to team skills dir (default: derived from
 *                                 TEAM_CONFIG path)
 *   MODEL              optional — model id (default: claude-sonnet-4-6)
 *   VISION_MODEL       optional — model for image captioning / BrowseWeb (default: claude-haiku-4-5-20251001)
 *   AGENT_WORKDIR      optional — working directory (default: cwd)
 *   MONITOR_PORT       optional — dashboard HTTP port (default: 4000; must be 1–65535)
 *   TOOL_PORT          optional — Tool API server port for background jobs (default: 4001; must be 1–65535)
 *   MAX_COST_USD       optional — spending cap in USD; pauses when reached
 *   MISSION_COPILOT_ENABLED  optional — "true" to inject the mission copilot (ADR-0016); default off
 *   MONITOR_TOKEN      optional — per-mission auth token for MonitorServer mutating routes
 *                                 (set by the control plane at machine creation; empty = no auth, local dev)
 *   CONTROL_PLANE_URL  optional — base URL for the mission copilot's GitHub proxy (ADR-0016 Phase 5);
 *                                 set by the control plane at machine creation; empty in local dev
 */

import {
	type ChildProcess,
	execFileSync,
	execSync,
	spawn,
} from "node:child_process";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTeamConfig, type TeamConfig } from "@magi/agent-config";

import { config as dotenvConfig } from "dotenv";

const REPO_ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
);

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
export const DATA_KEY_NAMES = [
	"FRED_API_KEY",
	"FMP_API_KEY",
	"NEWSAPIORG_API_KEY",
] as const;

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
import { ObjectId } from "mongodb";
import {
	createMongoAgentStatsRepository,
	StatsCollector,
} from "./agent-stats.js";
import { createMongoConversationRepository } from "./conversation-repository.js";
import { type JobSpec, recoverOrphanedJobs } from "./job-recovery.js";
import { createMongoLlmCallLogRepository } from "./llm-call-log.js";
import type { MailboxRepository } from "./mailbox.js";
import { createMongoMailboxRepository } from "./mailbox.js";
import {
	injectMissionCopilot,
	MISSION_COPILOT_AGENT_ID,
	seedMissionCopilotObjectives,
} from "./mission-copilot.js";
import { createMissionCopilotTools } from "./mission-copilot-tools.js";
import { resolveModel } from "./models.js";
import { connectMongo } from "./mongo.js";
import { MonitorServer } from "./monitor-server.js";
import { enrichModelPricing } from "./openrouter-pricing.js";
import { runOrchestrationLoop } from "./orchestrator.js";
import { ToolApiServer } from "./tool-api-server.js";
import type { AclPolicy } from "./tools.js";
import { UsageAccumulator } from "./usage.js";
import type { AgentIdentity } from "./workspace-manager.js";
import { WorkspaceManager } from "./workspace-manager.js";

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------
// JobSpec and recoverOrphanedJobs live in job-recovery.ts (kept out of this
// script's module scope so they're importable in unit tests without
// triggering daemon.ts's unconditional main() at module load).

/** Default job wall-clock timeout: 30 minutes (F-006). */
const DEFAULT_JOB_TIMEOUT_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// Background job execution
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_JOBS = 3;
/** Track running jobs so we enforce the concurrency limit. */
let runningJobs = 0;

/**
 * jobId → live ChildProcess, populated on spawn and cleared on exit (ADR-0016
 * — the mission copilot's CancelBackgroundJob). Before this, no registry
 * existed at all: runningJobs above is a bare counter, and the PID the
 * timeout handler kills is a closure-local variable inside runPendingJobs,
 * unreachable from anywhere else. This is the only way to reach a running
 * job's process from outside that closure.
 */
const runningJobProcesses = new Map<string, ChildProcess>();

/**
 * Kill a running background job's entire process group, the same
 * SIGKILL-the-process-group pattern the wall-clock timeout already uses.
 * Returns false if the job isn't currently running (already exited, or the
 * id is unknown) — the caller should report that, not treat it as success.
 */
export function cancelBackgroundJob(jobId: string): boolean {
	const child = runningJobProcesses.get(jobId);
	if (!child || child.pid === undefined) return false;
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		return false;
	}
	return true;
}

/**
 * Read the shebang line from a script and return the interpreter argv prefix.
 * Handles `#!/usr/bin/env <cmd>` → `/usr/local/bin/<cmd>` and direct paths.
 * Returns [] if no shebang found (caller falls back to direct execution).
 *
 * Why: WriteFile creates files without the execute bit (+x). Rather than
 * chmod-ing a file owned by a different user, we extract the interpreter from
 * the shebang and prepend it to the magi-job argv so the OS doesn't need +x.
 */
function readShebangInterpreter(scriptPath: string): string[] {
	try {
		const head = readFileSync(scriptPath, "utf8").slice(0, 256);
		const firstLine = head.split("\n")[0] ?? "";
		if (!firstLine.startsWith("#!")) return [];
		const shebang = firstLine.slice(2).trim();
		const envMatch = shebang.match(/^\/usr\/bin\/env\s+(\S+)/);
		if (envMatch) return [`/usr/local/bin/${envMatch[1]}`];
		return [shebang.split(/\s+/)[0]];
	} catch {
		return [];
	}
}

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
 *   3. Spawn: sudo -u <linuxUser> [interpreter] <scriptPath> <args...>
 *      with MAGI_TOOL_URL, MAGI_TOOL_TOKEN, data-key env vars, PATH, HOME.
 *      Interpreter is extracted from the script's shebang line — the script
 *      does not need to be executable (+x).
 *   4. Pipe stdout+stderr to logs/bg-<id>.log.
 *   5. On exit: revoke token, write jobs/status/<id>.json, optionally notify.
 */
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
	const statusDir = join(sharedDir, "jobs", "status");
	const logsDir = join(sharedDir, "logs");

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
			try {
				unlinkSync(runningPath);
			} catch {}
			continue;
		}
		const linuxUser = agentCfg.linuxUser ?? agentCfg.id;
		const agentWorkdir = join(
			workdir,
			"home",
			linuxUser,
			"missions",
			missionId,
		);
		const permittedPaths = [agentWorkdir, sharedDir];

		// F-013: Validate scriptPath using resolve() + realpathSync() to prevent
		// symlink traversal (an agent could symlink a script inside permittedPaths
		// to an arbitrary executable outside them).
		let resolvedScript: string;
		try {
			resolvedScript = resolve(spec.scriptPath);
			const realScript = realpathSync(resolvedScript);
			const scriptAllowed = permittedPaths.some(
				(p) => realScript === p || realScript.startsWith(`${p}/`),
			);
			if (!scriptAllowed) {
				console.error(
					`[daemon:jobs] scriptPath "${spec.scriptPath}" resolves outside permitted paths for agent "${spec.agentId}" — skipping`,
				);
				try {
					unlinkSync(runningPath);
				} catch {}
				continue;
			}
		} catch (e) {
			console.error(
				`[daemon:jobs] scriptPath "${spec.scriptPath}" could not be resolved: ${(e as Error).message} — skipping`,
			);
			try {
				unlinkSync(runningPath);
			} catch {}
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
		const interpreter = readShebangInterpreter(resolvedScript);
		console.log(
			`[daemon:jobs] Starting job ${spec.id} (${spec.scriptPath}) as ${linuxUser}`,
		);

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(
				"sudo",
				[
					"-u",
					linuxUser,
					"/usr/local/bin/magi-job",
					...interpreter,
					resolvedScript,
					...spec.args,
				],
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
			try {
				unlinkSync(runningPath);
			} catch {}
			console.error(
				`[daemon:jobs] Failed to spawn job ${spec.id}: ${(e as Error).message}`,
			);
			continue;
		}

		child.stdout?.pipe(logStream);
		child.stderr?.pipe(logStream);
		runningJobProcesses.set(spec.id, child);

		// F-006: Wall-clock timeout — kill the entire process group after timeoutMs.
		const jobTimeoutMs = spec.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
		const timeoutHandle = setTimeout(() => {
			console.error(
				`[daemon:jobs] Job ${spec.id} timed out after ${jobTimeoutMs}ms — killing`,
			);
			if (child.pid !== undefined) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {}
			} else {
				child.kill("SIGKILL");
			}
		}, jobTimeoutMs);

		child.on("close", (exitCode) => {
			clearTimeout(timeoutHandle);
			runningJobs--;
			runningJobProcesses.delete(spec.id);
			toolApiServer.revokeToken(token);
			logStream.end();

			// Clean up the running file.
			try {
				unlinkSync(runningPath);
			} catch {}

			// Write status file. Carries the full original spec (not just
			// scriptPath) so RestartBackgroundJob (ADR-0016) can resubmit an
			// exact retry — agentId/args/notifyAgentId/timeoutMs are otherwise
			// unrecoverable once jobs/running/<id>.json is cleaned up above.
			const statusPath = join(statusDir, `${spec.id}.json`);
			const status = {
				id: spec.id,
				agentId: spec.agentId,
				scriptPath: spec.scriptPath,
				args: spec.args,
				notifyAgentId: spec.notifyAgentId,
				notifySubject: spec.notifySubject,
				timeoutMs: spec.timeoutMs,
				exitCode: exitCode ?? -1,
				completedAt: new Date().toISOString(),
				logPath,
			};
			try {
				writeFileSync(statusPath, JSON.stringify(status, null, 2));
			} catch {}

			const success = exitCode === 0;
			console.log(
				`[daemon:jobs] Job ${spec.id} exited ${exitCode ?? "null"} — ${success ? "ok" : "FAILED"}`,
			);

			// Post completion notification if requested.
			if (spec.notifyAgentId) {
				const subject =
					spec.notifySubject ?? `Background job complete: ${spec.id}`;
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
						console.error(
							`[daemon:jobs] Failed to notify ${spec.notifyAgentId}: ${(e as Error).message}`,
						),
					);
			}

			// Additively: a failed job is otherwise visible only in
			// jobs/status/<id>.json — nothing wakes anyone up (GitHub #3).
			// The mission copilot (ADR-0016), when present, is the one agent
			// positioned to investigate and either fix or report it; notify it
			// regardless of whether the submitting agent also asked to be
			// notified via notifyAgentId.
			if (
				!success &&
				process.env.MISSION_COPILOT_ENABLED === "true" &&
				teamConfig.agents.some((a) => a.id === MISSION_COPILOT_AGENT_ID)
			) {
				mailboxRepo
					.post({
						missionId,
						from: "scheduler",
						to: [MISSION_COPILOT_AGENT_ID],
						subject: `Background job failed: ${spec.id}`,
						body:
							`Job "${spec.id}" (submitted by "${spec.agentId}") exited ` +
							`${exitCode ?? "null"}.\nScript: ${spec.scriptPath}\nLog: ${logPath}`,
					})
					.catch((e: unknown) =>
						console.error(
							`[daemon:jobs] Failed to notify mission copilot of job failure: ${(e as Error).message}`,
						),
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
		runPendingJobs(
			sharedDir,
			workdir,
			missionId,
			toolApiServer,
			toolPort,
			mailboxRepo,
			teamConfig,
		).catch((e) => console.error("[daemon:jobs] Heartbeat error:", e));
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
function ensureAgentUsers(
	agents: Array<{ id: string; linuxUser?: string }>,
): void {
	for (const agent of agents) {
		const linuxUser = agent.linuxUser ?? agent.id;
		try {
			execSync(`id ${linuxUser}`, { stdio: "ignore" });
		} catch {
			// User does not exist — create it.
			// In Docker (production) we use sudo magi-create-user which runs as root
			// and also writes the sudoers rule. In local dev environments without the
			// helper the pool users already exist, so this path is rarely reached.
			try {
				execSync(`sudo /usr/local/bin/magi-create-user ${linuxUser}`, {
					stdio: "inherit",
				});
				console.log(`[daemon] Created OS user: ${linuxUser}`);
			} catch (e) {
				// Non-fatal in local dev: pool users cover the common dev agents.
				// Fatal in Docker because setfacl will fail on the missing user.
				console.warn(
					`[daemon] Could not create OS user ${linuxUser}: ${(e as Error).message}`,
				);
			}
		}
	}
}

const MISSION_COPILOT_SRC_PATH = "/opt/magi-src";

/**
 * Grant the mission copilot's specific OS user read access to the bundled
 * platform source (ADR-0016).
 *
 * Why this can't be a Dockerfile permission alone: Bash has no software
 * checkPath — path enforcement for Bash is delegated entirely to OS Linux
 * ACLs (accepted finding A-002). AgentRunContext.permittedPaths (extended
 * for the copilot in agent-runner.ts) only gates WriteFile/EditFile. If
 * /opt/magi-src/ were world-or-group readable at the OS level, *any* agent
 * could read it via Bash regardless of permittedPaths — the actual
 * restriction has to be an OS-level ACL grant scoped to one specific Linux
 * user, the same setfacl-per-agent pattern WorkspaceManager already uses for
 * sharedDir/workdir. That user (agent id "copilot") doesn't exist until
 * ensureAgentUsers() creates it, so this must run at daemon startup, not at
 * image build time — the Dockerfile only makes the directory readable by
 * magi-operator itself (mode 750, owned by magi-operator's own dedicated
 * group — confirmed via a real image build), not by any other user.
 *
 * Best-effort: /opt/magi-src/ only exists in the built execution-plane
 * image, never in local dev — skip silently when absent, matching every
 * other ACL call's tolerance for unsupported/missing environments.
 */
function grantMissionCopilotSourceAccess(linuxUser: string): void {
	if (!existsSync(MISSION_COPILOT_SRC_PATH)) return;
	try {
		execFileSync(
			"setfacl",
			["-R", "-m", `u:${linuxUser}:rX`, MISSION_COPILOT_SRC_PATH],
			{ stdio: "ignore" },
		);
		console.log(
			`[daemon] Granted ${linuxUser} read access to ${MISSION_COPILOT_SRC_PATH}`,
		);
	} catch (e) {
		console.error(
			`[daemon] Failed to grant ${linuxUser} access to ${MISSION_COPILOT_SRC_PATH}: ${(e as Error).message}`,
		);
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

	// Tee all stdout/stderr to $AGENT_WORKDIR/daemon.log (append mode, survives
	// restarts). The operator can read this file via GET /log on the monitor server.
	const workdirForLog = process.env.AGENT_WORKDIR ?? process.cwd();
	try {
		mkdirSync(workdirForLog, { recursive: true });
		const logStream = createWriteStream(join(workdirForLog, "daemon.log"), {
			flags: "a",
		});
		const origStdoutWrite = process.stdout.write.bind(process.stdout);
		const origStderrWrite = process.stderr.write.bind(process.stderr);
		// biome-ignore lint/suspicious/noExplicitAny: wrapping native write
		(process.stdout.write as any) = (chunk: any, ...args: any[]) => {
			logStream.write(chunk);
			return origStdoutWrite(chunk, ...args);
		};
		// biome-ignore lint/suspicious/noExplicitAny: wrapping native write
		(process.stderr.write as any) = (chunk: any, ...args: any[]) => {
			logStream.write(chunk);
			return origStderrWrite(chunk, ...args);
		};
	} catch {
		// Log setup failure is non-fatal — daemon continues without file logging.
	}

	// Write TEAM_CONFIG_YAML env var to the TEAM_CONFIG path on every boot.
	// Always overwrites so that config edits made via the control plane (stored
	// in MongoDB and pushed back via Fly machine env update on resume) take effect.
	const teamConfigYamlEnv = process.env.TEAM_CONFIG_YAML;
	const teamConfigTarget = process.env.TEAM_CONFIG;
	if (teamConfigYamlEnv && teamConfigTarget) {
		mkdirSync(dirname(teamConfigTarget), { recursive: true });
		writeFileSync(
			teamConfigTarget,
			Buffer.from(teamConfigYamlEnv, "base64").toString("utf-8"),
		);
		process.stdout.write(
			`[daemon] Wrote team config from env to ${teamConfigTarget}\n`,
		);
	}

	// Team files are fetched from MongoDB after connection (see below) — the
	// previous TEAM_FILES_PAYLOAD env var approach exceeded Fly's machine config
	// size limit for team configs with many skill files.

	const teamConfigPath = process.env.TEAM_CONFIG;
	const mongoUri = process.env.MONGODB_URI;

	process.stdout.write(`[daemon] TEAM_CONFIG=${teamConfigPath ?? "(unset)"}\n`);
	process.stdout.write(
		`[daemon] MONGODB_URI=${mongoUri ? "(set)" : "(unset)"}\n`,
	);
	process.stdout.write(
		`[daemon] ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? "(set)" : "(unset)"}\n`,
	);
	process.stdout.write(
		`[daemon] BRAVE_SEARCH_API_KEY=${process.env.BRAVE_SEARCH_API_KEY ? "(set)" : "(unset)"}\n`,
	);
	for (const key of DATA_KEY_NAMES) {
		process.stdout.write(
			`[daemon] ${key}=${process.env[key] ? "(set)" : "(unset)"}\n`,
		);
	}

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
	// MISSION_ID env var (set by control plane at machine creation) overrides the YAML's
	// mission.id so each provisioned mission has its own isolated MongoDB namespace.
	const missionId = process.env.MISSION_ID ?? teamConfig.mission.id;
	if (process.env.MISSION_ID) {
		teamConfig.mission.id = missionId;
	}
	// Mission copilot injection (ADR-0016) — in-memory only, must run before
	// ensureAgentUsers so the copilot gets a real per-agent OS user and
	// workspace ACL through the exact same path every other agent goes
	// through. Defaults OFF: this repo deploys every push to main straight to
	// production, and the copilot's full elevated tool surface doesn't exist
	// until Track 2's later phases land — defaulting on here would give every
	// real mission (in the window before those phases ship) a copilot whose
	// system prompt claims capabilities it doesn't have yet.
	if (process.env.MISSION_COPILOT_ENABLED === "true") {
		injectMissionCopilot(teamConfig);
	}

	process.stdout.write(
		`[daemon] Mission: ${missionId} (${teamConfig.agents.length} agents)\n`,
	);

	// Ensure every agent has a Linux OS user. No-op for existing pool users
	// (dev/test); creates per-agent users in production Docker.
	process.stdout.write("[daemon] Ensuring agent OS users…\n");
	ensureAgentUsers(teamConfig.agents);

	// Must run after ensureAgentUsers — the copilot's OS user needs to exist
	// before it can be granted an ACL entry.
	if (process.env.MISSION_COPILOT_ENABLED === "true") {
		const copilotAgent = teamConfig.agents.find(
			(a) => a.id === MISSION_COPILOT_AGENT_ID,
		);
		if (copilotAgent) {
			grantMissionCopilotSourceAccess(
				copilotAgent.linuxUser ?? copilotAgent.id,
			);
		}
	}

	process.stdout.write("[daemon] Connecting to MongoDB…\n");
	const { client, db } = await connectMongo(mongoUri);
	process.stdout.write("[daemon] MongoDB connected.\n");

	// Fetch team files from the mission document and write to /missions/team/ on
	// every boot. Stored in MongoDB before machine provisioning so they survive
	// restarts without requiring a TEAM_FILES_PAYLOAD env var (which would exceed
	// Fly's machine config size limit for large team configs).
	const teamFilesConfigTarget = process.env.TEAM_CONFIG;
	if (teamFilesConfigTarget) {
		try {
			const missionDoc = await db
				.collection("missions")
				.findOne({ missionId }, { projection: { teamFiles: 1 } });
			const dbFiles = missionDoc?.teamFiles as
				| Array<{ path: string; content: string }>
				| undefined;
			if (dbFiles && dbFiles.length > 0) {
				const teamDir = join(
					dirname(teamFilesConfigTarget),
					basename(teamFilesConfigTarget, ".yaml"),
				);
				let written = 0;
				for (const { path: relPath, content } of dbFiles) {
					const dest = join(teamDir, relPath);
					mkdirSync(dirname(dest), { recursive: true });
					writeFileSync(dest, content);
					written++;
				}
				process.stdout.write(
					`[daemon] Wrote ${written} team files from MongoDB to ${teamDir}\n`,
				);
			}
		} catch (e) {
			process.stderr.write(
				`[daemon] Failed to write team files from MongoDB: ${(e as Error).message}\n`,
			);
		}
	}

	const mailboxRepo = createMongoMailboxRepository(db, missionId);
	const conversationRepo = createMongoConversationRepository(db);
	const llmCallLog = createMongoLlmCallLogRepository(db);
	const statsCollector = new StatsCollector(
		createMongoAgentStatsRepository(db),
	);

	const copilotMissionId = process.env.COPILOT_MISSION_ID;
	const copilotMailboxRepo = copilotMissionId
		? createMongoMailboxRepository(db, copilotMissionId)
		: undefined;

	const modelId =
		teamConfig.mission.model ?? process.env.MODEL ?? "claude-sonnet-4-6";
	const model = resolveModel(modelId);

	const visionModelId =
		teamConfig.mission.visionModel ??
		process.env.VISION_MODEL ??
		"claude-haiku-4-5-20251001";
	const visionModel = resolveModel(visionModelId);

	// Overwrite OpenRouter models' static cost with live list pricing (no-op for
	// first-party Anthropic models, whose cost is already exact). See issue #10.
	await Promise.all([
		enrichModelPricing(model),
		enrichModelPricing(visionModel),
	]);

	const workdir = process.env.AGENT_WORKDIR ?? process.cwd();
	// TEAM_SKILLS_PATH is set by the control plane when the YAML is injected from MongoDB
	// so team-specific skills are still read from the baked-in image path.
	const teamSkillsPath =
		process.env.TEAM_SKILLS_PATH ??
		join(dirname(teamConfigPath), basename(teamConfigPath, ".yaml"), "skills");
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
		console.log(
			`\n[daemon] ${reason} — shutting down… (Ctrl-C again to force)`,
		);
		ac.abort();
	}
	process.on("SIGTERM", () => initiateShutdown("SIGTERM"));
	process.on("SIGINT", () => initiateShutdown("Interrupted"));

	// PID file — enables cli:stop and guards against duplicate daemons.
	const missionDir = join(workdir, "missions", missionId);
	mkdirSync(missionDir, { recursive: true });
	const pidFile = join(missionDir, "daemon.pid");

	// Check for a running instance before writing our own PID.
	try {
		const existingPid = Number.parseInt(
			readFileSync(pidFile, "utf8").trim(),
			10,
		);
		if (!Number.isNaN(existingPid) && existingPid !== process.pid) {
			try {
				// Signal 0 tests liveness without sending a real signal.
				process.kill(existingPid, 0);
				// If we reach here the process is alive — refuse to start.
				console.error(
					`[daemon] Already running as PID ${existingPid} (mission: ${missionId}).`,
				);
				console.error(`[daemon] Run: MISSION_ID=${missionId} npm run cli:stop`);
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
	const sharedDir = join(workdir, "missions", missionId, "shared");
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
		workdir,
		sharedDir,
		async (id) => {
			// missionId-scoped: without it, any valid ObjectId (guessed or
			// leaked from another mission) could cancel a different mission's
			// scheduled message — the same missing-scope bug class Track 1
			// fixed for the control-plane copilot's B1 tools, found here too.
			await db
				.collection("scheduled_messages")
				.deleteOne({ _id: new ObjectId(id), missionId });
		},
	);
	// Vision model for the upload pipeline's image captioning (Sprint 25).
	monitor.visionModel = visionModel;
	await monitor.start(monitorPort);
	process.stdout.write(
		`[daemon] Monitor server listening on port ${monitorPort}\n`,
	);

	// Tool API server — exposes LLM tools to background job scripts.
	const toolApiServer = new ToolApiServer(
		model,
		visionModel,
		sharedDir,
		mailboxRepo,
		teamConfig,
	);
	toolApiServer.listen(toolPort);

	// F-010: Recover jobs that were left in running/ by a prior daemon run.
	// They have no live token, so their magi-tool calls would fail with 401.
	// Moving them back to pending/ allows the next heartbeat to retry them —
	// unless a job has already caused too many crashes, in which case it is
	// failed out permanently instead (see recoverOrphanedJobs' doc comment).
	await recoverOrphanedJobs(sharedDir, missionId, mailboxRepo);
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
	console.log(`[daemon] Dashboard: http://localhost:${monitorPort}`);

	// Keep daemon's local maxCostUsd in sync when the operator extends the budget.
	monitor.onBudgetExtended = (newCapUsd) => {
		maxCostUsd = newCapUsd;
		console.log(`[daemon] Spending cap updated to $${newCapUsd.toFixed(2)}`);
	};

	console.log("[daemon] Entering orchestration loop");

	// Mission copilot elevated tools (ADR-0016). Built once (not per-dispatch)
	// since everything it closes over — db, mailboxRepo, sharedDir, the
	// monitor's own port/token, and the team roster — is stable for the
	// lifetime of this process; config changes only take effect on next
	// resume, so the roster snapshot here is correct for the whole run.
	// getAdditionalTools is keyed on the literal agent id "copilot" — never
	// on anything from teamConfig — so a compromised copilot cannot escalate
	// a different agent to elevated status via SaveMissionConfig (Phase 3).
	const missionCopilotTools =
		process.env.MISSION_COPILOT_ENABLED === "true"
			? createMissionCopilotTools({
					db,
					missionId,
					sharedDir,
					mailboxRepo,
					monitorPort,
					monitorToken: process.env.MONITOR_TOKEN ?? "",
					teamAgentIds: teamConfig.agents.map((a) => a.id),
					cancelBackgroundJob,
					controlPlaneUrl: process.env.CONTROL_PLANE_URL ?? "",
				})
			: undefined;

	try {
		await runOrchestrationLoop(
			{
				teamConfig,
				mailboxRepo,
				conversationRepo,
				llmCallLog,
				statsCollector,
				model,
				visionModel,
				workdir,
				workspaceManager,
				copilotMailboxRepo,
				waitForMail,
				waitForStep: () => monitor.waitForStep(),
				waitForBudget: () => monitor.waitForBudget(),
				isAgentPaused: (agentId) => monitor.isAgentPaused(agentId),
				getAdditionalTools: (agentId) =>
					agentId === MISSION_COPILOT_AGENT_ID
						? missionCopilotTools
						: undefined,
				onLimitAlert: (alert) => {
					const { agentId, turnNumber, breach } = alert;
					const { rule, value } = breach;
					// Surface on the dashboard immediately.
					monitor.push("limit-alert", {
						agentId,
						turnNumber,
						severity: rule.severity,
						ruleId: rule.id,
						metric: rule.metric,
						value,
						threshold: rule.threshold,
						label: rule.label,
					});
					console.warn(
						`[daemon] limit ${rule.severity} ${rule.id}: ${agentId} turn ${turnNumber} — ${rule.metric}=${value} > ${rule.threshold} (${rule.label})`,
					);
					// Route to the copilot so it can assess and intervene (between turns).
					copilotMailboxRepo
						?.post({
							missionId: "copilot",
							from: "system",
							to: ["copilot"],
							subject: `Limit ${rule.severity}: ${agentId} (${rule.metric})`,
							body:
								`Agent "${agentId}" in mission "${missionId}" breached a ${rule.severity} limit on ` +
								`turn ${turnNumber}: ${rule.metric}=${value} exceeded threshold ${rule.threshold} (${rule.label}).` +
								(rule.severity === "hard"
									? " The turn was aborted."
									: " The turn continued; assess whether intervention is warranted."),
						})
						.catch((e: Error) =>
							console.error(
								`[daemon] failed to post limit alert to copilot: ${e.message}`,
							),
						);
					// Additively: also wake this mission's own copilot, which has
					// direct in-mission access to actually diagnose it (ADR-0016).
					if (
						process.env.MISSION_COPILOT_ENABLED === "true" &&
						teamConfig.agents.some((a) => a.id === MISSION_COPILOT_AGENT_ID)
					) {
						mailboxRepo
							.post({
								missionId,
								from: "system",
								to: [MISSION_COPILOT_AGENT_ID],
								subject: `Limit ${rule.severity}: ${agentId} (${rule.metric})`,
								body:
									`Agent "${agentId}" breached a ${rule.severity} limit on turn ${turnNumber}: ` +
									`${rule.metric}=${value} exceeded threshold ${rule.threshold} (${rule.label}).` +
									(rule.severity === "hard"
										? " The turn was aborted."
										: " The turn continued; assess whether intervention is warranted."),
							})
							.catch((e: Error) =>
								console.error(
									`[daemon] failed to post limit alert to mission copilot: ${e.message}`,
								),
							);
					}
				},
				onAgentError: (agentId, errorMessage) =>
					monitor.push("agent-error", {
						agentId,
						errorMessage,
						transient: false,
					}),
				onAgentStart: (agentId) => monitor.notifyAgentStart(agentId),
				onWorkspaceReady: (workdirs) => {
					monitor.setAgentWorkdirs(workdirs);
					// Seed after provisioning, not at injection time — provision()
					// is what creates sharedDir/objectives/ on disk. Idempotent, so
					// a resume_mission reprovision (which re-runs this whole path)
					// never duplicates the seed.
					if (
						process.env.MISSION_COPILOT_ENABLED === "true" &&
						workdirs.has(MISSION_COPILOT_AGENT_ID)
					) {
						seedMissionCopilotObjectives(sharedDir).catch((e: Error) =>
							console.error(
								`[daemon] failed to seed mission copilot objectives: ${e.message}`,
							),
						);
					}
				},
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
						const am = msg as AssistantMessage;
						if (am.stopReason === "error") {
							const errMsg = am.errorMessage ?? "";
							// Classify: credit/auth errors require operator action;
							// overload/rate-limit errors are transient and auto-resolve.
							const transient =
								errMsg.includes("overloaded") ||
								errMsg.includes("rate limit") ||
								errMsg.includes("529");
							monitor.push("agent-error", {
								agentId,
								errorMessage: errMsg,
								transient,
							});
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
	process.stderr.write(
		`[daemon] Fatal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
	);
	process.exitCode = 1;
});
