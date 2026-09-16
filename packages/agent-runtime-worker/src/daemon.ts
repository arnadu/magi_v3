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
 *   MISSION_ID         one of MISSION_ID/TEAM_CONFIG required — control-plane-provisioned path
 *                                 (ADR-0021): reads this mission's structured `mission`/`agents`/
 *                                 `missionCopilotLimits` fields directly from its `missions`
 *                                 document. No YAML file, no baked-image fallback — a missing or
 *                                 invalid document is a hard boot failure, not a silent default.
 *   TEAM_CONFIG        one of MISSION_ID/TEAM_CONFIG required — standalone local/dev path: path
 *                                 to a hand-authored team config YAML file, no MongoDB `missions`
 *                                 document needed. Ignored when MISSION_ID is set.
 *   TEAM_SKILLS_PATH   optional — override path to team skills dir (default: derived from
 *                                 wherever this boot's team files were written — see teamDir)
 *   MODEL              optional — model id (default: claude-sonnet-4-6)
 *   VISION_MODEL       optional — model for image captioning / BrowseWeb (default: claude-haiku-4-5-20251001)
 *   AGENT_WORKDIR      optional — working directory (default: cwd)
 *   MONITOR_PORT       optional — dashboard HTTP port (default: 4000; must be 1–65535)
 *   TOOL_PORT          optional — Tool API server port for background jobs (default: 4001; must be 1–65535)
 *   MAX_COST_USD       optional — spending cap in USD; pauses when reached. The mission's own
 *                                 persisted mission.maxCostUsd (set via the cockpit Limits panel
 *                                 or the mission copilot) is read fresh from MongoDB on every
 *                                 check and takes precedence (ADR-0018 — no suspend/resume
 *                                 needed for a cap change to apply); this env var is only the
 *                                 fallback used when no cap is configured or a live read fails
 *   MISSION_COPILOT_ENABLED  optional — "false" to opt a mission out of the mission copilot
 *                                 (ADR-0016); default on
 *   MONITOR_TOKEN      optional — per-mission auth token for MonitorServer mutating routes
 *                                 (set by the control plane at machine creation; empty = no auth, local dev)
 *   CONTROL_PLANE_URL  optional — base URL for the mission copilot's GitHub proxy (ADR-0016 Phase 5);
 *                                 set by the control plane at machine creation; empty in local dev
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	createWriteStream,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TeamConfig } from "@magi/agent-config";

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
import { wireAbortSignal } from "./daemon-boot/abort-signal.js";
import { provisionAgentIdentities } from "./daemon-boot/agent-identity.js";
import type { BootContext } from "./daemon-boot/context.js";
import { parseDaemonEnv } from "./daemon-boot/env.js";
import { setupLogTee } from "./daemon-boot/log-tee.js";
import { constructAnomalyRecorder } from "./daemon-boot/mission-owner.js";
import { resolveModelsAndPricing } from "./daemon-boot/model-pricing.js";
import { connectToMongo } from "./daemon-boot/mongo-connect.js";
import {
	startMonitorServer,
	startToolApiServer,
} from "./daemon-boot/monitor-tool-servers.js";
import { lockPidFile } from "./daemon-boot/pid-lock.js";
import { constructRepositories } from "./daemon-boot/repositories.js";
import { loadDaemonTeamConfig } from "./daemon-boot/team-config.js";
import { syncTeamFiles } from "./daemon-boot/team-files-sync.js";
import { resolveUsageAndCap } from "./daemon-boot/usage-cap.js";
import { constructWorkspaceManager } from "./daemon-boot/workspace.js";
import { type JobSpec, recoverOrphanedJobs } from "./job-recovery.js";
import { missionLifetimeCostUsd } from "./limits.js";
import { resolveLinuxUsers } from "./linux-user.js";
import type { MailboxRepository } from "./mailbox.js";
import {
	MISSION_COPILOT_AGENT_ID,
	seedMissionCopilotObjectives,
} from "./mission-copilot.js";
import { createMissionCopilotTools } from "./mission-copilot-tools.js";
import { migrateLegacyObjectivesStore } from "./objectives/migrate-legacy-store.js";
import { runOrchestrationLoop } from "./orchestrator.js";
import type { ToolApiServer } from "./tool-api-server.js";
import type { AclPolicy } from "./tools.js";
import type { AgentIdentity } from "./workspace-manager.js";

/**
 * Mission copilot (ADR-0016): default-on as of Sprint 26, validated end-to-end
 * (real Docker build, live test mission, full integration suite) before this
 * flip. Set MISSION_COPILOT_ENABLED=false to opt a mission out. Single source
 * of truth for the default so every call site agrees — and so the flag can be
 * deleted in one place (Sequencing step 12) once default-on has run in
 * production without incident.
 */
const missionCopilotEnabled = process.env.MISSION_COPILOT_ENABLED !== "false";

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
		const linuxUser = resolveLinuxUsers(teamConfig.agents).get(agentCfg.id);
		if (!linuxUser) {
			console.error(
				`[daemon:jobs] Could not resolve a Linux user for agentId "${spec.agentId}" in job ${spec.id} — skipping`,
			);
			try {
				unlinkSync(runningPath);
			} catch {}
			continue;
		}
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
				missionCopilotEnabled &&
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
// Diagnostic only (issue #31) — does not confirm or fix the suspected
// OOM-driven crash correlation with concurrent scheduled wakeups, but gives
// future crashes a memory trend to correlate against. Piggybacks on the job
// runner's existing 60s tick rather than adding a second interval.
function logMemoryUsage(missionId: string): void {
	const mem = process.memoryUsage();
	const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
	console.log(
		`[daemon] memory { missionId: "${missionId}", rssMb: ${mb(mem.rss)}, heapUsedMb: ${mb(mem.heapUsed)}, externalMb: ${mb(mem.external)} }`,
	);
}

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
		logMemoryUsage(missionId);
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
	// Widens to a full BootContext by the end of main() as more phases are
	// extracted (Sprint 28c, issue #33); Partial<> during the transition since
	// not every field's producing phase has been pulled out yet.
	const ctx: Partial<BootContext> = { repoRoot: REPO_ROOT };
	Object.assign(ctx, setupLogTee());

	const envResult = parseDaemonEnv(DATA_KEY_NAMES);
	if (!envResult.ok) {
		process.stderr.write(`${envResult.exitMessage}\n`);
		process.exitCode = 1;
		return;
	}
	const { teamConfigPath, missionIdEnv, mongoUri, agentWorkdir } = envResult;

	Object.assign(ctx, { mongoUri });
	const { client, db } = await connectToMongo({ mongoUri });
	Object.assign(ctx, { client, db });

	const teamConfigResult = await loadDaemonTeamConfig({
		db,
		missionIdEnv,
		teamConfigPath,
		agentWorkdir,
	});
	if (!teamConfigResult.ok) {
		process.stderr.write(`${teamConfigResult.exitMessage}\n`);
		process.exitCode = 1;
		return;
	}
	const { teamConfig, missionId, teamDir } = teamConfigResult;
	Object.assign(ctx, { missionId, teamDir, teamConfig });

	provisionAgentIdentities({ teamConfig, missionId }, missionCopilotEnabled);

	await syncTeamFiles({ db, missionId, teamDir });

	const repos = constructRepositories({ db, missionId });
	Object.assign(ctx, repos);
	const {
		mailboxRepo,
		conversationRepo,
		llmCallLog,
		statsCollector,
		missionConfigRepo,
		objectivesRepo,
	} = repos;

	const { anomalyRecorder } = await constructAnomalyRecorder(
		{ db, missionId, teamConfig, mailboxRepo },
		missionCopilotEnabled,
	);
	Object.assign(ctx, { anomalyRecorder });

	const { modelId, model, visionModel } = await resolveModelsAndPricing({
		teamConfig,
	});
	Object.assign(ctx, { modelId, model, visionModel });

	const workdir = agentWorkdir;
	Object.assign(ctx, { workdir });
	const { workspaceManager } = constructWorkspaceManager({
		workdir,
		teamDir,
		repoRoot: REPO_ROOT,
	});
	Object.assign(ctx, { workspaceManager });

	// Abort controller — fired by SIGTERM / SIGINT / cost cap / monitor stop.
	const { ac, signal } = wireAbortSignal();
	Object.assign(ctx, { ac, signal });

	const { pidFile } = lockPidFile({ workdir, missionId, anomalyRecorder });
	Object.assign(ctx, { pidFile });

	const { usageAccumulator, maxCostUsd } = resolveUsageAndCap({ teamConfig });
	Object.assign(ctx, { usageAccumulator, maxCostUsd });

	const { monitorPort, toolPort, sharedDir, workspaceGit, monitor } =
		await startMonitorServer({
			db,
			missionId,
			teamConfig,
			modelId,
			usageAccumulator,
			statsCollector,
			missionConfigRepo,
			mailboxRepo,
			ac,
			workdir,
			visionModel,
		});
	Object.assign(ctx, {
		monitorPort,
		toolPort,
		sharedDir,
		workspaceGit,
		monitor,
	});

	const { toolApiServer } = startToolApiServer({
		model,
		visionModel,
		sharedDir,
		mailboxRepo,
		teamConfig,
		toolPort,
	});
	Object.assign(ctx, { toolApiServer });

	// F-010: Recover jobs that were left in running/ by a prior daemon run.
	// They have no live token, so their magi-tool calls would fail with 401.
	// Moving them back to pending/ allows the next heartbeat to retry them —
	// unless a job has already caused too many crashes, in which case it is
	// failed out permanently instead (see recoverOrphanedJobs' doc comment).
	await recoverOrphanedJobs(sharedDir, missionId, mailboxRepo, anomalyRecorder);
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

	console.log("[daemon] Entering orchestration loop");

	// Mission copilot elevated tools (ADR-0016). Built once (not per-dispatch)
	// since everything it closes over — db, mailboxRepo, sharedDir, the
	// monitor's own port/token, and the team roster — is stable for the
	// lifetime of this process; config changes only take effect on next
	// resume, so the roster snapshot here is correct for the whole run.
	// getAdditionalTools is keyed on the literal agent id "mission-copilot" —
	// never on anything from teamConfig — so a compromised copilot cannot
	// escalate a different agent to elevated status via SaveMissionConfig
	// (Phase 3).
	const missionCopilotTools = missionCopilotEnabled
		? createMissionCopilotTools({
				db,
				missionId,
				sharedDir,
				objectivesRepo,
				mailboxRepo,
				monitorPort,
				monitorToken: process.env.MONITOR_TOKEN ?? "",
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
				missionConfig: missionConfigRepo,
				objectivesRepo,
				model,
				visionModel,
				workdir,
				workspaceManager,
				workspaceGit,
				anomalyRecorder,
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
					const body =
						`Agent "${agentId}" breached a ${rule.severity} limit on turn ${turnNumber}: ` +
						`${rule.metric}=${value} exceeded threshold ${rule.threshold} (${rule.label}).` +
						(rule.severity === "hard"
							? " The turn was aborted."
							: " The turn continued; assess whether intervention is warranted.");
					// Persist + wake this mission's own copilot (and, for hard
					// breaches, relay to the control-plane copilot) — both handled
					// internally by anomalyRecorder (ADR-0020).
					anomalyRecorder
						.record({
							missionId,
							category: "limit-breach",
							severity: rule.severity,
							agentId,
							turnNumber,
							message: body,
						})
						.catch((e: Error) =>
							console.error(
								`[daemon] failed to record limit-breach anomaly: ${e.message}`,
							),
						);
					// Also notify the operator directly (issue #41) — the copilot
					// relay above is not a substitute: a hard breach on every agent,
					// including the mission copilot itself, previously left no one
					// able to surface it, and the operator only found out days later.
					if (rule.severity === "hard") {
						mailboxRepo
							.post({
								missionId,
								from: "system",
								to: ["user"],
								subject: `Spend limit hit — "${agentId}"`,
								body,
							})
							.catch((e: Error) =>
								console.error(
									`[daemon] failed to notify operator of limit breach { missionId: "${missionId}", agentId: "${agentId}" }: ${e.message}`,
								),
							);
					}
				},
				// Whole-turn crash (runAgent rejected). This is purely the SSE
				// dashboard signal — orchestrator.ts's own dispatch-error handler
				// (which has the errMsg first-hand) records the anomaly and relays
				// it; recording it again here from the same event would double it.
				onAgentError: (agentId, errorMessage) =>
					monitor.push("agent-error", {
						agentId,
						errorMessage,
						transient: false,
					}),
				onAgentStart: (agentId) => monitor.notifyAgentStart(agentId),
				onWorkspaceReady: (workdirs) => {
					monitor.setAgentWorkdirs(workdirs);
					// Migrate any legacy file-based objectives (ADR-0019) after
					// provisioning, not at injection time — provision() is what
					// creates sharedDir/objectives/ on disk for a fresh-from-template
					// mission. Idempotent (no-ops once a mission has an
					// objectivesGoals doc), so a resume_mission reprovision (which
					// re-runs this whole path) never re-imports. Chained (not fired
					// in parallel) before the copilot seed so a legacy
					// OBJ-MISSION-FIT is picked up first and the seed correctly
					// no-ops on it.
					migrateLegacyObjectivesStore(sharedDir, missionId, objectivesRepo)
						.catch((e: Error) =>
							console.error(
								`[daemon] failed to migrate legacy objectives store: ${e.message}`,
							),
						)
						.then(() => {
							if (
								missionCopilotEnabled &&
								workdirs.has(MISSION_COPILOT_AGENT_ID)
							) {
								return seedMissionCopilotObjectives(
									objectivesRepo,
									missionId,
								).catch((e: Error) =>
									console.error(
										`[daemon] failed to seed mission copilot objectives: ${e.message}`,
									),
								);
							}
						});
				},
				onAgentDone: (agentId) => monitor.notifyAgentDone(agentId),
				onIdle: () => monitor.notifyIdle(),
				onMentalMapUpdate: (agentId, html) =>
					monitor.notifyMentalMapUpdate(agentId, html),
				onAgentMessage: async (agentId, msg) => {
					logMessage(msg, agentId);
					if (msg.role === "assistant") {
						const usage = (msg as AssistantMessage).usage as Usage;
						// Session-only telemetry for the console log line and the SSE
						// live ticker — cosmetic, never checked against a limit (see
						// usage.ts header). The mission-wide cap below reads fresh from
						// missionStats instead.
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
						// Mission-wide spend cap (ADR-0018): read the cap fresh from the
						// mission's persisted config on every call — never the boot-time
						// teamConfig snapshot — so a cap added, changed, or cleared live
						// (cockpit or mission copilot) is enforced without a restart.
						// Falls back to the boot-time value (mission config or
						// MAX_COST_USD env var, resolved once above) when a live read
						// fails or the live doc genuinely has no cap configured. A
						// transient Mongo read failure must not crash the agent's turn —
						// fail open (skip this one check) and log; both reads are
						// re-attempted on every subsequent LLM call, so a one-off hiccup
						// self-heals rather than blocking the mission.
						try {
							const [snapshot, liveConfig] = await Promise.all([
								statsCollector.readMissionSnapshot(missionId),
								missionConfigRepo.readTeamConfig(missionId),
							]);
							const effectiveCap = liveConfig?.mission.maxCostUsd ?? maxCostUsd;
							if (effectiveCap !== null) {
								const missionTotal = missionLifetimeCostUsd(snapshot);
								if (missionTotal >= effectiveCap) {
									await monitor.notifyCostPause(missionTotal, effectiveCap);
									// This path previously never woke the copilot or the
									// operator (issue #41) — only a dashboard-only SSE event,
									// unlike the per-agent path above. A silent mission-wide
									// pause cost 5 days of unattended operation in production.
									const pauseBody = `Mission-wide spend cap reached: $${missionTotal.toFixed(2)} of $${effectiveCap.toFixed(2)}. All agents are paused until the cap is raised or cleared.`;
									anomalyRecorder
										.record({
											missionId,
											category: "limit-breach",
											severity: "hard",
											message: pauseBody,
										})
										.catch((e: Error) =>
											console.error(
												`[daemon] failed to record mission-cap anomaly { missionId: "${missionId}" }: ${e.message}`,
											),
										);
									mailboxRepo
										.post({
											missionId,
											from: "system",
											to: ["user"],
											subject: "Mission spend cap reached",
											body: pauseBody,
										})
										.catch((e: Error) =>
											console.error(
												`[daemon] failed to notify operator of mission-cap pause { missionId: "${missionId}" }: ${e.message}`,
											),
										);
								}
							}
						} catch (e) {
							console.error(
								`[daemon] mission cap check failed { missionId: ${missionId} }: ${(e as Error).message}`,
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
							anomalyRecorder
								.record({
									missionId,
									category: "llm-error",
									severity: transient ? "soft" : "hard",
									agentId,
									message: `Agent "${agentId}" had an LLM call fail: ${errMsg}`,
								})
								.catch((e: Error) =>
									console.error(
										`[daemon] failed to record llm-error anomaly: ${e.message}`,
									),
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
	process.stderr.write(
		`[daemon] Fatal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
	);
	process.exitCode = 1;
});
