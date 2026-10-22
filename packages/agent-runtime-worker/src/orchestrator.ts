import type { TeamConfig } from "@magi/agent-config";
import type { Message, Model } from "@mariozechner/pi-ai";
import type { StatsCollector } from "./agent-stats.js";
import type { AnomalyRecorder } from "./anomaly.js";
import type { ConversationRepository } from "./conversation-repository.js";
import type { LimitAlert } from "./limits.js";
import type { LlmCallLogRepository } from "./llm-call-log.js";
import type { MailboxMessage, MailboxRepository } from "./mailbox.js";
import type { MissionConfigRepository } from "./mission-config.js";
import type { ObjectivesRepository } from "./objectives/repository.js";
import { Dispatcher } from "./orchestrator-dispatch.js";
import {
	buildAgentContext,
	openUserInput,
	postUserLine,
	promptUser,
	provisionTeam,
	type UserInput,
} from "./orchestrator-setup.js";
import type { MagiTool } from "./tools.js";
import type { WorkspaceGit } from "./workspace-git.js";
import type { WorkspaceManager } from "./workspace-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
	teamConfig: TeamConfig;
	mailboxRepo: MailboxRepository;
	conversationRepo: ConversationRepository;
	/** Optional LLM call audit log — written for every LLM call across all agents. */
	llmCallLog?: LlmCallLogRepository;
	/**
	 * Optional per-turn / mission statistics collector. Shared across all agents
	 * in the mission; keyed internally by agentId. Powers budget limits and the
	 * trace viewer.
	 */
	statsCollector?: StatsCollector;
	/**
	 * Optional live config reader (ADR-0018). Forwarded to each agent run so
	 * `enforceLimits` can read the agent's current `limits` fresh from MongoDB
	 * instead of the boot-time teamConfig snapshot.
	 */
	missionConfig?: MissionConfigRepository;
	/**
	 * Optional Mongo-backed objectives store (ADR-0019). Forwarded to each
	 * agent run — see `AgentRunContext.objectivesRepo`'s doc comment.
	 */
	objectivesRepo?: ObjectivesRepository;
	/**
	 * Called when a configured agent limit is breached (soft = advisory, hard =
	 * turn aborted). The daemon routes these to the copilot mailbox and the
	 * monitor dashboard. Forwarded to each agent run; requires `statsCollector`.
	 */
	onLimitAlert?: (alert: LimitAlert) => void;
	model: Model<string>;
	/**
	 * Secondary model used for vision-only tasks: FetchUrl image captioning,
	 * InspectImage, and BrowseWeb page understanding.
	 * Defaults to model when absent (single-model mode).
	 * Set VISION_MODEL env var to override; defaults to claude-haiku-4-5-20251001.
	 */
	visionModel?: Model<string>;
	/**
	 * Working directory used for operator-level operations such as @path file
	 * uploads typed at the interactive prompt. Not used as an agent workdir —
	 * each agent gets its own private directory from workspaceManager.
	 */
	workdir: string;
	/**
	 * Provisions per-agent workspaces with private directories and ACL
	 * enforcement. Required — every orchestration run must have a workspace.
	 */
	workspaceManager: WorkspaceManager;
	/**
	 * Git-commit-on-sleep checkpointer for the shared workspace. Optional —
	 * when absent, the orchestrator constructs its own (the pre-existing
	 * behavior, still correct for cli.ts/tests, which have no other consumer
	 * that needs to share the same commit queue). daemon.ts supplies one
	 * explicitly so MonitorServer's file-edit route can commit through the
	 * exact same serialized queue as agent turn-end commits, rather than
	 * racing a second, independent WorkspaceGit instance against it.
	 */
	workspaceGit?: WorkspaceGit;
	/**
	 * Max total agent dispatches across the whole loop lifetime.
	 * Default: 50.
	 */
	maxRuns?: number;
	/**
	 * Wall-clock timeout per agent dispatch in seconds. If a single agent run
	 * exceeds this limit (hung LLM call, pathological tool loop), the dispatch
	 * is aborted via AbortSignal and the orchestrator continues normally.
	 * Defaults to MAX_AGENT_RUN_SECONDS env var, or 4 hours.
	 */
	maxAgentRunSeconds?: number;
	/**
	 * If true, pause after each agent dispatch and prompt the operator to
	 * continue or inject a message. Useful during development.
	 */
	step?: boolean;
	/** Called immediately when an agent posts a message to "user". */
	onUserMessage?: (msg: MailboxMessage) => void;
	/**
	 * Called for every inner-loop message produced by any agent (for logging/streaming).
	 * May return a Promise — the orchestrator awaits it before letting the loop
	 * continue, so a mission-wide budget check here is guaranteed to run using
	 * this call's stats before the next LLM call is dispatched.
	 */
	onAgentMessage?: (agentId: string, msg: Message) => void | Promise<void>;
	/**
	 * Called just before an agent is dispatched.
	 * `activePeers` lists the agents currently running concurrently (not including agentId).
	 */
	onAgentStart?: (agentId: string, activePeers: string[]) => void;
	/** Called immediately after an agent's loop returns. */
	onAgentDone?: (agentId: string) => void;
	/** Called when an agent's mental map is updated (for SSE push to dashboard). */
	onMentalMapUpdate?: (agentId: string, html: string) => void;
	/** Called when no agents are running and no agent has unread mail. */
	onIdle?: () => void;
	/**
	 * When provided, called to block until a new mailbox message arrives.
	 * The daemon supplies a Change Stream watch that resolves when a new
	 * MailboxMessage is inserted. After it resolves, the loop re-dispatches.
	 * When absent (cli.ts / tests), the loop exits when all work is drained.
	 */
	waitForMail?: () => Promise<void>;
	/**
	 * When provided, called before every agent dispatch. Resolves immediately when
	 * step mode is off; blocks until the operator clicks "Run" in the monitor
	 * dashboard (or calls POST /step) when step mode is on.
	 * This hook takes priority over the TTY readline step mode.
	 * When present, dispatch is serialised: one agent starts per permit.
	 */
	waitForStep?: () => Promise<void>;
	/**
	 * When provided, called after every agent dispatch. Resolves immediately when
	 * the mission is within budget; blocks until the operator extends the budget
	 * via the monitor dashboard (POST /extend-budget) when the cap is reached.
	 */
	waitForBudget?: () => Promise<void>;
	/**
	 * Whether the spend cap has paused the mission. With waitForBudget, it
	 * also parks every running turn before its next LLM call (CST-2), not just
	 * the next dispatch.
	 */
	isBudgetPaused?: () => boolean;
	/**
	 * If true, call workspaceManager.teardown() on exit (removing workdirs and
	 * the shared mission dir). Default: false.
	 *
	 * The daemon must NOT set this — the workspace (agent files, git history,
	 * briefs, scripts) must survive daemon restarts. Only the CLI and integration
	 * tests set this to true, since they provision a fresh temp workspace per run.
	 */
	teardownOnExit?: boolean;
	/**
	 * Optional predicate; returns true if the named agent should be skipped in
	 * dispatch. Reserved for the Copilot sprint (PauseAgent capability).
	 */
	isAgentPaused?: (agentId: string) => boolean;
	/** Cooldown before re-dispatching an agent whose last LLM call failed; default failureBackoffMs (30 s → 5 min, or Retry-After). */
	errorCooldownMs?: (failures: number, errorMessage: string) => number;
	/**
	 * Optional per-agent elevated tool set, appended to that agent's tool list
	 * for this dispatch. Introduced for the mission copilot (ADR-0016): the
	 * daemon implementation must key this purely on the literal agent id
	 * "mission-copilot" — never on anything from teamConfig — since elevated-tool
	 * grant is the structural boundary that keeps a compromised agent from
	 * escalating itself or another agent via a config edit (e.g.
	 * SaveMissionConfig). Returns undefined for every agent that shouldn't
	 * get elevated tools, including the common case of no copilot at all.
	 */
	getAdditionalTools?: (agentId: string) => MagiTool[] | undefined;
	/**
	 * Called once after workspace provisioning, with a map of agentId → workdir.
	 * The daemon uses this to register workdirs with the monitor server for the
	 * file browser.
	 */
	onWorkspaceReady?: (workdirs: Map<string, string>) => void;
	/**
	 * When provided, wall-clock timeouts and dispatch-level crashes are recorded
	 * as anomalies — persisted to `missionAnomalies`, mailed to the mission
	 * copilot (if present), and relayed to the control-plane copilot (ADR-0020).
	 */
	anomalyRecorder?: AnomalyRecorder;
	/**
	 * Called when runAgent rejects (whole-turn crash, not an LLM error).
	 * LLM errors are surfaced via onAgentMessage with stopReason === "error".
	 * The daemon wires this to monitor.push("agent-error") so the dashboard
	 * shows a red banner for whole-turn crashes as well.
	 */
	onAgentError?: (agentId: string, errorMessage: string) => void;
	/**
	 * Hosts exempt from the SSRF guard for FetchUrl/BrowseWeb — TEST
	 * INFRASTRUCTURE ONLY. Forwarded to each agent run. Never set by the
	 * daemon/CLI → SSRF stays fully enforced in production.
	 */
	allowedHosts?: string[];
}

// ---------------------------------------------------------------------------
// runOrchestrationLoop
// ---------------------------------------------------------------------------

/**
 * Concurrent orchestration loop.
 *
 * Scheduling rule: an agent is dispatched whenever it has unread messages and
 * is not already running. Multiple agents run concurrently as independent
 * fire-and-forget promises.
 *
 * The loop terminates when no agent has unread messages (and none are running),
 * or when maxRuns is reached, or when the AbortSignal fires.
 *
 * The workspaceManager provisions per-agent private directories and ACL
 * enforcement before the first dispatch and tears them down on exit.
 */
export async function runOrchestrationLoop(
	config: OrchestratorConfig,
	signal?: AbortSignal,
): Promise<void> {
	const { teamConfig, workspaceManager } = config;
	// The default cap exists for the CLI, where "drain and stop" is the point.
	// A daemon (waitForMail set) runs until told to stop: with the CLI default
	// it exited 0 after 50 dispatches, and Fly's on-failure policy never
	// restarted it (audit D1).
	const maxRuns =
		config.maxRuns ?? (config.waitForMail ? Number.POSITIVE_INFINITY : 50);
	const leadAgent = teamConfig.agents[0];
	if (!leadAgent) throw new Error("Team config must have at least one agent");

	const { identities, workspaceGit } = await provisionTeam(config);
	const input = openUserInput();
	const dispatcher = new Dispatcher({
		config,
		signal,
		maxRuns,
		identities,
		agentCtx: buildAgentContext(config, workspaceGit),
		input,
		leadAgentId: leadAgent.id,
	});

	try {
		await dispatcher.dispatchReady();
		if (config.waitForMail) {
			await runDaemonMode(config.waitForMail, dispatcher, maxRuns, signal);
		} else {
			await runCliMode(config, dispatcher, input, leadAgent.id, signal);
		}
		// Shutdown: abort all running agents and wait for clean exit.
		for (const ctrl of dispatcher.active.values()) ctrl.abort();
		await Promise.allSettled([...dispatcher.activePromises.values()]);
		console.log(
			`\n[orchestrator] Mission complete (${dispatcher.totalRuns()} run(s))`,
		);
	} finally {
		dispatcher.dispose();
		input.rl?.close();
		if (config.teardownOnExit) {
			workspaceManager.teardown(teamConfig.mission.id, identities);
		}
	}
}

/**
 * Daemon mode: the mailbox Change Stream drives re-dispatch — waitForMail()
 * blocks until any mailbox insert (operator or agent). Ends on abort, at
 * maxRuns, or when the stream fails.
 */
async function runDaemonMode(
	waitForMail: () => Promise<void>,
	dispatcher: Dispatcher,
	maxRuns: number,
	signal?: AbortSignal,
): Promise<void> {
	while (!signal?.aborted && dispatcher.totalRuns() < maxRuns) {
		try {
			await waitForMail();
		} catch {
			break; // Change Stream error or abort
		}
		if (signal?.aborted) break;
		await dispatcher.dispatchReady();
	}
}

/**
 * CLI mode: drain all work — wait for running agents, re-dispatch the mail
 * they sent each other — then offer a TTY prompt or end.
 */
async function runCliMode(
	config: OrchestratorConfig,
	dispatcher: Dispatcher,
	input: UserInput,
	leadAgentId: string,
	signal?: AbortSignal,
): Promise<void> {
	while (!signal?.aborted) {
		const snapshot = [...dispatcher.activePromises.values()];
		if (snapshot.length > 0) {
			await Promise.allSettled(snapshot);
			await dispatcher.dispatchReady();
			continue;
		}
		if (await dispatcher.anyAgentHasUnreadMail()) {
			await dispatcher.dispatchReady();
			// Nothing started (maxRuns reached or every agent paused): stop.
			if (dispatcher.active.size === 0) break;
			continue;
		}
		if (!input.rl) break;
		const line = await promptUser(
			input.rl,
			"Mission paused. Type a message to continue, or press Enter to end: ",
		);
		if (
			!line ||
			!(await postUserLine(
				config.mailboxRepo,
				config.teamConfig.mission.id,
				leadAgentId,
				line,
				config.workdir,
			))
		) {
			break;
		}
		await dispatcher.dispatchReady();
	}
}
