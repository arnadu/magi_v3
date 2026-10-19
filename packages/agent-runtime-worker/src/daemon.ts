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

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { storedCollection, type TeamConfig } from "@magi/agent-config";
import { config as dotenvConfig } from "dotenv";
import { removeIfExists } from "./remove-if-exists.js";

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

import type { Db } from "mongodb";
import type { AnomalyRecorder } from "./anomaly.js";
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
import {
	cancelBackgroundJob,
	runningJobCount,
	runPendingJobs,
} from "./job-runner.js";
import { buildUidToAgentId } from "./linux-user.js";
import type { MailboxRepository } from "./mailbox.js";
import { MISSION_COPILOT_AGENT_ID } from "./mission-copilot.js";
import { runOrchestrationLoop } from "./orchestrator.js";
import { sampleDiskUsage } from "./resource-sampler.js";
import { createScheduleIngestor } from "./schedule-ingest.js";
import type { ToolApiServer } from "./tool-api-server.js";

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
// ---------------------------------------------------------------------------
// Background job runner
// ---------------------------------------------------------------------------

/**
 * Start a heartbeat that, every minute: imports the agents' schedule files
 * into `scheduled_messages` and turns the control plane's job-fire stamps
 * into queued jobs (schedule-ingest.ts, ADR-0033 §3), then runs pending
 * background jobs. Scheduled delivery itself — the clock — is the control
 * plane's (scheduler.ts); the daemon only executes.
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
	db: Db,
	anomalyRecorder: AnomalyRecorder,
): () => void {
	// Who may submit a job: resolved once; the roster does not change while
	// the daemon runs (a config change restarts it).
	const uidToAgentId = buildUidToAgentId(teamConfig.agents);
	const daemonUid = process.getuid?.() ?? -1;
	const schedules = createScheduleIngestor({
		sharedDir,
		missionId,
		db,
		teamConfig,
		uidToAgentId,
		daemonUid,
		anomalyRecorder,
	});
	function tick(): void {
		logMemoryUsage(missionId);
		sampleDiskUsage({
			db,
			anomalyRecorder,
			missionId,
			// The Fly Volume mount root, not the per-agent `workdir` above — any
			// path on the same filesystem gives statfs() the same totals, but
			// `du`'s breakdown should cover the whole mission, not one agent.
			workdir: process.env.AGENT_WORKDIR ?? process.cwd(),
			rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
			runningJobs: runningJobCount(),
			// FLY_APP_NAME is unset in local dev, where AGENT_WORKDIR is an
			// ordinary host directory, not a real volume — alerting on its
			// fill level there would be meaningless.
			alertsEnabled: Boolean(process.env.FLY_APP_NAME),
		}).catch((e) =>
			console.error(
				`[resource-sampler] Uncaught failure { missionId: "${missionId}", error: "${(e as Error).message}" }`,
			),
		);
		// Schedules first so a job fired this minute runs this minute; a
		// failure there must not stop the job runner.
		schedules
			.ingest()
			.then(() => schedules.claimJobFires())
			.catch((e) =>
				console.error(
					`[daemon:scheduler] Schedule tick failed { missionId: "${missionId}", error: "${(e as Error).message}" } — schedule files and job fires are retried next minute`,
				),
			)
			.then(() =>
				runPendingJobs({
					sharedDir,
					workdir,
					missionId,
					teamConfig,
					toolApiServer,
					toolPort,
					mailboxRepo,
					missionCopilotEnabled,
					uidToAgentId,
					daemonUid,
				}),
			);
	}

	// Run any pending jobs immediately on startup (handles crash recovery).
	tick();

	const handle = setInterval(tick, 60_000);
	return () => clearInterval(handle);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Everything the orchestration run and shutdown need (the env-only fields stay in bootDataLayer). */
type RunningMission = Omit<BootContext, "repoRoot" | "mongoUri">;

type DataLayer = Pick<
	BootContext,
	| "client"
	| "db"
	| "missionId"
	| "teamDir"
	| "teamConfig"
	| "mailboxRepo"
	| "conversationRepo"
	| "llmCallLog"
	| "statsCollector"
	| "missionConfigRepo"
	| "objectivesRepo"
	| "anomalyRecorder"
	| "modelId"
	| "model"
	| "visionModel"
	| "workdir"
	| "workspaceManager"
>;

/**
 * Env, Mongo, team config, agent identities, team files, repositories, the
 * anomaly recorder, models and the workspace manager. Null (with exitCode
 * set) when the env or the team config is unusable.
 */
async function bootDataLayer(): Promise<DataLayer | null> {
	const envResult = parseDaemonEnv(DATA_KEY_NAMES);
	if (!envResult.ok) {
		process.stderr.write(`${envResult.exitMessage}\n`);
		process.exitCode = 1;
		return null;
	}
	const { teamConfigPath, missionIdEnv, mongoUri, agentWorkdir } = envResult;
	const { client, db } = await connectToMongo({ mongoUri });

	const teamConfigResult = await loadDaemonTeamConfig({
		db,
		missionIdEnv,
		teamConfigPath,
		agentWorkdir,
	});
	if (!teamConfigResult.ok) {
		process.stderr.write(`${teamConfigResult.exitMessage}\n`);
		process.exitCode = 1;
		return null;
	}
	const { teamConfig, missionId, teamDir } = teamConfigResult;

	provisionAgentIdentities({ teamConfig, missionId }, missionCopilotEnabled);
	await syncTeamFiles({ db, missionId, teamDir });

	const repos = constructRepositories({ db, missionId });
	const { anomalyRecorder } = await constructAnomalyRecorder(
		{ db, missionId, teamConfig, mailboxRepo: repos.mailboxRepo },
		missionCopilotEnabled,
	);
	const models = await resolveModelsAndPricing({ teamConfig });
	const workdir = agentWorkdir;
	const { workspaceManager } = constructWorkspaceManager({
		workdir,
		teamDir,
		repoRoot: REPO_ROOT,
	});
	return {
		client,
		db,
		missionId,
		teamDir,
		teamConfig,
		...repos,
		anomalyRecorder,
		...models,
		workdir,
		workspaceManager,
	};
}

/**
 * The abort signal, pid lock, usage cap, monitor and tool servers,
 * background job runner, mail waiter and the mission copilot's tools.
 */
async function startServices(data: DataLayer): Promise<RunningMission> {
	const { db, missionId, teamConfig, mailboxRepo, anomalyRecorder, workdir } =
		data;
	// Abort controller — fired by SIGTERM / SIGINT / cost cap / monitor stop.
	const { ac, signal } = wireAbortSignal();
	const { pidFile } = lockPidFile({ workdir, missionId, anomalyRecorder });
	const { usageAccumulator, maxCostUsd } = resolveUsageAndCap({ teamConfig });

	const { monitorPort, toolPort, sharedDir, workspaceGit, monitor } =
		await startMonitorServer({
			db,
			missionId,
			llmCallLog: data.llmCallLog,
			teamConfig,
			modelId: data.modelId,
			usageAccumulator,
			statsCollector: data.statsCollector,
			missionConfigRepo: data.missionConfigRepo,
			mailboxRepo,
			ac,
			workdir,
			visionModel: data.visionModel,
		});

	const { toolApiServer } = startToolApiServer({
		model: data.model,
		visionModel: data.visionModel,
		sharedDir,
		mailboxRepo,
		teamConfig,
		toolPort,
	});

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
			db,
		},
		startJobRunner,
	);

	// Change Stream: wake when a new MailboxMessage is inserted for this mission.
	const waitForMail = createMailWaiter(
		storedCollection(db, "mailbox"),
		missionId,
		signal,
	);

	console.log(`[daemon] Mission: ${teamConfig.mission.name} (${missionId})`);
	console.log(`[daemon] Dashboard: http://localhost:${monitorPort}`);
	console.log("[daemon] Entering orchestration loop");

	const { missionCopilotTools } = buildMissionCopilotTools(
		{
			db,
			missionId,
			sharedDir,
			objectivesRepo: data.objectivesRepo,
			mailboxRepo,
			monitorPort,
		},
		missionCopilotEnabled,
		cancelBackgroundJob,
	);
	return {
		...data,
		ac,
		signal,
		pidFile,
		usageAccumulator,
		maxCostUsd,
		monitorPort,
		toolPort,
		sharedDir,
		workspaceGit,
		monitor,
		toolApiServer,
		stopJobRunner,
		waitForMail,
		missionCopilotTools,
	};
}

/** The orchestration loop, then shutdown and the process exit (non-zero when the loop ended unasked). */
async function runAndShutdown(ctx: RunningMission): Promise<void> {
	const { monitor, signal, missionId, anomalyRecorder, mailboxRepo } = ctx;
	try {
		await runOrchestrationLoop(
			{
				teamConfig: ctx.teamConfig,
				mailboxRepo,
				conversationRepo: ctx.conversationRepo,
				llmCallLog: ctx.llmCallLog,
				statsCollector: ctx.statsCollector,
				missionConfig: ctx.missionConfigRepo,
				objectivesRepo: ctx.objectivesRepo,
				model: ctx.model,
				visionModel: ctx.visionModel,
				workdir: ctx.workdir,
				workspaceManager: ctx.workspaceManager,
				workspaceGit: ctx.workspaceGit,
				anomalyRecorder,
				waitForMail: ctx.waitForMail,
				waitForStep: () => monitor.waitForStep(),
				waitForBudget: () => monitor.waitForBudget(),
				isAgentPaused: (agentId) => monitor.isAgentPaused(agentId),
				// Keyed on the literal agent id, never on anything from teamConfig —
				// see buildMissionCopilotTools' doc comment (daemon-boot/copilot-tools.ts).
				getAdditionalTools: (agentId) =>
					agentId === MISSION_COPILOT_AGENT_ID
						? ctx.missionCopilotTools
						: undefined,
				...createRemainingOrchestrationCallbacks(
					{
						monitor,
						anomalyRecorder,
						missionId,
						mailboxRepo,
						sharedDir: ctx.sharedDir,
						objectivesRepo: ctx.objectivesRepo,
					},
					missionCopilotEnabled,
				),
				onAgentMessage: createOnAgentMessage({
					usageAccumulator: ctx.usageAccumulator,
					monitor,
					statsCollector: ctx.statsCollector,
					missionId,
					missionConfigRepo: ctx.missionConfigRepo,
					maxCostUsd: ctx.maxCostUsd,
					anomalyRecorder,
					mailboxRepo,
				}),
			},
			signal,
		);
	} finally {
		monitor.push("shutdown", { reason: signal.aborted ? "abort" : "normal" });
		monitor.stop();
		ctx.toolApiServer.stop();
		ctx.stopJobRunner();
		await ctx.client.close();
		removeIfExists(
			ctx.pidFile,
			"the next start sees a stale pid file and checks whether that process is alive",
		);
		// Print final usage roll-up.
		console.log(ctx.usageAccumulator.fullSummary());
		console.log("[daemon] Shutdown complete");
	}
	// Force-exit after cleanup. The MongoDB driver and other async handles can
	// keep the event loop alive even after client.close() — process.exit() is
	// the only reliable way to free the port and terminate cleanly. A loop
	// that ends without a shutdown signal is a failure (the Change Stream
	// died, or a cap fired) — exit non-zero so the machine's on-failure
	// restart policy brings the daemon back (audit D1).
	if (!signal.aborted) {
		console.error(
			"[daemon] orchestration loop ended without a shutdown signal — exiting 1 so the supervisor restarts the daemon",
		);
		process.exit(1);
	}
	process.exit(0);
}

async function main(): Promise<void> {
	setupLogTee();
	const data = await bootDataLayer();
	if (!data) return;
	await runAndShutdown(await startServices(data));
}

main().catch((e) => {
	// Synchronous write — async stderr can be lost if process.exit() fires first.
	process.stderr.write(
		`[daemon] Fatal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
	);
	process.exitCode = 1;
});
