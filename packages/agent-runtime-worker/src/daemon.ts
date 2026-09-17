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
 * Names of the data-provider API keys loaded from .env.data-keys — logged
 * (presence only) at boot via parseDaemonEnv(). Never forwarded to
 * background job subprocesses (CR-04, job-env half): the daemon holds these
 * itself and job code reaches them only through the data-fred/data-fmp/
 * data-newsapi tools on the loopback ToolApiServer, never as raw env values.
 */
export const DATA_KEY_NAMES = [
	"FRED_API_KEY",
	"FMP_API_KEY",
	"NEWSAPIORG_API_KEY",
] as const;

import { wireAbortSignal } from "./daemon-boot/abort-signal.js";
import { provisionAgentIdentities } from "./daemon-boot/agent-identity.js";
import type { BootContext } from "./daemon-boot/context.js";
import { buildMissionCopilotTools } from "./daemon-boot/copilot-tools.js";
import { parseDaemonEnv } from "./daemon-boot/env.js";
import { startBackgroundJobs } from "./daemon-boot/job-runner-start.js";
import { setupLogTee } from "./daemon-boot/log-tee.js";
import { createMailWaiter } from "./daemon-boot/mail-waiter.js";
import { constructAnomalyRecorder } from "./daemon-boot/mission-owner.js";
import { resolveModelsAndPricing } from "./daemon-boot/model-pricing.js";
import { connectToMongo } from "./daemon-boot/mongo-connect.js";
import {
	startMonitorServer,
	startToolApiServer,
} from "./daemon-boot/monitor-tool-servers.js";
import {
	createOnAgentMessage,
	createRemainingOrchestrationCallbacks,
} from "./daemon-boot/orchestration-callbacks.js";
import { lockPidFile } from "./daemon-boot/pid-lock.js";
import { constructRepositories } from "./daemon-boot/repositories.js";
import { loadDaemonTeamConfig } from "./daemon-boot/team-config.js";
import { syncTeamFiles } from "./daemon-boot/team-files-sync.js";
import { resolveUsageAndCap } from "./daemon-boot/usage-cap.js";
import { constructWorkspaceManager } from "./daemon-boot/workspace.js";
import type { JobSpec } from "./job-recovery.js";
import { resolveLinuxUsers } from "./linux-user.js";
import type { MailboxRepository } from "./mailbox.js";
import { MISSION_COPILOT_AGENT_ID } from "./mission-copilot.js";
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
					// CR-04 (job-env half): the raw FRED_API_KEY/FMP_API_KEY/
					// NEWSAPIORG_API_KEY used to be spread here directly — this is
					// agent-authored code, and a reusable third-party credential in
					// its env could be read and exfiltrated with no privilege
					// escalation needed. The data-factory adapters now call the
					// data-fred/data-fmp/data-newsapi tools through MAGI_TOOL_URL
					// instead (tool-api-server.ts, tools/data-provider-proxy.ts) —
					// the daemon holds the real keys, the job gets a capability.
					env: {
						PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
						HOME: `/home/${linuxUser}`,
						MAGI_TOOL_URL: `http://127.0.0.1:${toolPort}`,
						MAGI_TOOL_TOKEN: token,
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

	// Scheduled message delivery has moved to the control plane (Sprint 14).
	// The daemon only runs background job files written to jobs/pending/.
	const { stopJobRunner } = await startBackgroundJobs(
		{
			sharedDir,
			workdir,
			missionId,
			mailboxRepo,
			anomalyRecorder,
			toolApiServer,
			toolPort,
			teamConfig,
		},
		startJobRunner,
	);
	Object.assign(ctx, { stopJobRunner });

	// Change Stream: wake when a new MailboxMessage is inserted for this mission.
	const mailboxCol = db.collection("mailbox");
	const waitForMail = createMailWaiter(mailboxCol, missionId, signal);
	Object.assign(ctx, { waitForMail });

	console.log(`[daemon] Mission: ${teamConfig.mission.name} (${missionId})`);
	console.log(`[daemon] Dashboard: http://localhost:${monitorPort}`);

	console.log("[daemon] Entering orchestration loop");

	const { missionCopilotTools } = buildMissionCopilotTools(
		{ db, missionId, sharedDir, objectivesRepo, mailboxRepo, monitorPort },
		missionCopilotEnabled,
		cancelBackgroundJob,
	);
	Object.assign(ctx, { missionCopilotTools });

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
				// Keyed on the literal agent id, never on anything from teamConfig —
				// see buildMissionCopilotTools' doc comment (daemon-boot/copilot-tools.ts).
				getAdditionalTools: (agentId) =>
					agentId === MISSION_COPILOT_AGENT_ID
						? missionCopilotTools
						: undefined,
				...createRemainingOrchestrationCallbacks(
					{
						monitor,
						anomalyRecorder,
						missionId,
						mailboxRepo,
						sharedDir,
						objectivesRepo,
					},
					missionCopilotEnabled,
				),
				onAgentMessage: createOnAgentMessage({
					usageAccumulator,
					monitor,
					statsCollector,
					missionId,
					missionConfigRepo,
					maxCostUsd,
					anomalyRecorder,
					mailboxRepo,
				}),
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
