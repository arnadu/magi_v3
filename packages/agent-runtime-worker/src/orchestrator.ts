import * as readline from "node:readline";
import type { TeamConfig } from "@magi/agent-config";
import type { Message, Model } from "@mariozechner/pi-ai";
import { runAgent } from "./agent-runner.js";
import type { StatsCollector } from "./agent-stats.js";
import type { ConversationRepository } from "./conversation-repository.js";
import type { LimitAlert } from "./limits.js";
import type { LlmCallLogRepository } from "./llm-call-log.js";
import type { MailboxMessage, MailboxRepository } from "./mailbox.js";
import { verifyIsolation } from "./tools.js";
import { processUserInput } from "./user-input.js";
import { WorkspaceGit } from "./workspace-git.js";
import type { WorkspaceManager } from "./workspace-manager.js";

// Per-dispatch wall-clock timeout: abort a hung agent run after this many
// seconds. Override with MAX_AGENT_RUN_SECONDS env var. Default 4 hours.
const MAX_AGENT_RUN_SECONDS =
	Number(process.env.MAX_AGENT_RUN_SECONDS) || 4 * 3600;

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
	/** Called for every inner-loop message produced by any agent (for logging/streaming). */
	onAgentMessage?: (agentId: string, msg: Message) => void;
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
	/**
	 * Called once after workspace provisioning, with a map of agentId → workdir.
	 * The daemon uses this to register workdirs with the monitor server for the
	 * file browser.
	 */
	onWorkspaceReady?: (workdirs: Map<string, string>) => void;
	/**
	 * When provided, wall-clock timeouts and non-transient agent errors are posted
	 * as alert messages to this mailbox so the copilot can diagnose and respond.
	 */
	copilotMailboxRepo?: MailboxRepository;
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
	const {
		teamConfig,
		mailboxRepo,
		conversationRepo,
		llmCallLog,
		model,
		visionModel = model,
		workdir,
		step = false,
		onUserMessage,
		workspaceManager,
	} = config;
	const maxRuns = config.maxRuns ?? 50;
	const missionId = teamConfig.mission.id;

	const leadAgent = teamConfig.agents[0];
	if (!leadAgent) throw new Error("Team config must have at least one agent");

	// Provision workspace for all agents.
	// linuxUser falls back to agent.id when omitted (production Docker — ensureAgentUsers
	// creates the OS user from agent.id at daemon startup).
	const agentDefs = teamConfig.agents.map((a) => ({
		id: a.id,
		linuxUser: a.linuxUser ?? a.id,
	}));
	const identities = workspaceManager.provision(missionId, agentDefs);
	console.log(
		`[orchestrator] Workspace provisioned for ${identities.size} agent(s)`,
	);
	if (config.onWorkspaceReady) {
		const workdirMap = new Map(
			[...identities.entries()].map(([id, ws]) => [id, ws.workdir]),
		);
		config.onWorkspaceReady(workdirMap);
	}

	// Verify isolation invariant: ANTHROPIC_API_KEY must not be visible in
	// child processes. Fails fast if sudo is misconfigured or secrets leak.
	const firstIdentity = identities.get(agentDefs[0].id);
	if (!firstIdentity)
		throw new Error("No identity for first agent after provision");
	await verifyIsolation(firstIdentity.linuxUser, firstIdentity.workdir);
	console.log(
		"[orchestrator] Isolation verified — child env does not contain secrets",
	);

	// git-commit-on-sleep: one WorkspaceGit per mission (serializes commits across
	// concurrent agents). All agents share the same sharedDir / git repo, which
	// WorkspaceManager.provision() has already initialised.
	const workspaceGit = new WorkspaceGit(firstIdentity.sharedDir);

	// Buffer for user input typed during agent runs.
	const inputBuffer: string[] = [];
	let rl: readline.Interface | null = null;

	// Only wire up readline if we're running interactively (TTY).
	if (process.stdin.isTTY) {
		rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: false,
		});
		rl.on("line", (line) => {
			if (line.trim()) inputBuffer.push(line.trim());
		});
		// readline intercepts Ctrl+C on stdin; re-raise as a process SIGINT.
		rl.on("SIGINT", () => process.emit("SIGINT"));
	}

	const agentCtx = {
		model,
		visionModel,
		teamConfig,
		mailboxRepo,
		conversationRepo,
		llmCallLog,
		statsCollector: config.statsCollector,
		onLimitAlert: config.onLimitAlert,
		commitWorkspace: (message: string) => workspaceGit.commit(message),
		allowedHosts: config.allowedHosts,
		onMentalMapUpdate: config.onMentalMapUpdate,
		onUserMessage: (msg: MailboxMessage) => {
			const timestamp = msg.timestamp.toISOString();
			console.log(`\n[→ USER from ${msg.from}] ${msg.subject} (${timestamp})`);
			console.log(msg.body);
			console.log();
			onUserMessage?.(msg);
		},
	};

	// Concurrent dispatcher state.
	const active = new Map<string, AbortController>(); // agentId → AbortController
	const activePromises = new Map<string, Promise<void>>(); // agentId → completion promise
	let totalRuns = 0;

	// Drain buffered user input → post to lead's inbox.
	async function flushInputBuffer(): Promise<void> {
		while (inputBuffer.length > 0) {
			const line = inputBuffer.shift() as string;
			const body = await processUserInput(line, workdir);
			if (!body) continue;
			await mailboxRepo.post({
				missionId,
				from: "user",
				to: [leadAgent.id],
				subject: "User message",
				body,
			});
		}
	}

	async function anyAgentHasUnreadMail(): Promise<boolean> {
		for (const agent of teamConfig.agents) {
			if (await mailboxRepo.hasUnread(agent.id)) return true;
		}
		return false;
	}

	async function checkIdle(): Promise<void> {
		if (active.size > 0 || signal?.aborted) return;
		if (!(await anyAgentHasUnreadMail())) config.onIdle?.();
	}

	/**
	 * Dispatch all agents that have unread mail and are not already running or
	 * paused. Agents run concurrently — no await on runAgent.
	 */
	async function dispatchReady(): Promise<void> {
		if (signal?.aborted) return;

		await flushInputBuffer();

		for (const agent of teamConfig.agents) {
			const agentId = agent.id;
			if (active.has(agentId)) continue;
			if (config.isAgentPaused?.(agentId)) continue;
			if (agent.active === false) continue;
			if (totalRuns >= maxRuns) break;

			// Skip agents with no pending mail before acquiring step/budget permits.
			if (!(await mailboxRepo.hasUnread(agentId))) continue;

			// Step mode: serialise dispatch — one agent starts per permit.
			if (config.waitForStep) {
				await config.waitForStep();
				if (signal?.aborted) return;
			} else if (step && rl) {
				// TTY step mode — readline prompt before dispatching.
				const input = await promptUser(
					rl,
					`[step] About to run ${agent.name ?? agentId}. Press Enter or type a message: `,
				);
				if (input) {
					const body = await processUserInput(input, workdir);
					if (body) {
						await mailboxRepo.post({
							missionId,
							from: "user",
							to: [leadAgent.id],
							subject: "User message",
							body,
						});
					}
				}
				if (signal?.aborted) return;
			}

			// Budget gate — blocks when the spending cap is reached.
			if (config.waitForBudget) {
				await config.waitForBudget();
				if (signal?.aborted) return;
			}

			// Re-check after yielding for step/budget: mail might have been consumed
			// or the agent might have been dispatched by a concurrent dispatchReady call.
			if (active.has(agentId)) continue;
			if (!(await mailboxRepo.hasUnread(agentId))) continue;

			const messages = await mailboxRepo.listUnread(agentId);
			if (messages.length === 0) continue;

			await mailboxRepo.markRead(
				messages.map((m) => m.id),
				agentId,
			);

			const identity = identities.get(agentId);
			if (!identity)
				throw new Error(`No workspace identity for agent "${agentId}"`);

			totalRuns++;
			const ctrl = new AbortController();
			const onParentAbort = () => ctrl.abort();
			signal?.addEventListener("abort", onParentAbort, { once: true });

			// Per-dispatch wall-clock timeout. Guards against hung LLM calls or
			// pathological tool loops that would otherwise freeze the orchestrator
			// indefinitely. Abort propagates into runAgent via the existing signal.
			const maxRunMs =
				(config.maxAgentRunSeconds ?? MAX_AGENT_RUN_SECONDS) * 1000;
			const runTimeoutId = setTimeout(() => {
				if (!ctrl.signal.aborted) {
					console.warn(
						`[orchestrator] ${agentId} exceeded ${maxRunMs / 1000}s wall-clock limit — aborting`,
					);
					ctrl.abort();
					config.copilotMailboxRepo
						?.post({
							missionId: "copilot",
							from: "system",
							to: ["copilot"],
							subject: `Agent timeout: ${agentId}`,
							body:
								`Agent "${agentId}" in mission "${missionId}" exceeded the ` +
								`${maxRunMs / 1000}s wall-clock limit and was aborted. ` +
								`Please investigate and consider resuming or restarting the mission.`,
						})
						.catch((e: Error) =>
							console.error(
								`[orchestrator] failed to post copilot alert: ${e.message}`,
							),
						);
				}
			}, maxRunMs);

			active.set(agentId, ctrl);
			config.onAgentStart?.(
				agentId,
				[...active.keys()].filter((id) => id !== agentId),
			);

			console.log(
				`\n[orchestrator] Running ${agent.name ?? agentId}` +
					` (${identity.linuxUser}) (${messages.length} message(s))`,
			);

			const promise = runAgent(
				agentId,
				messages,
				{
					...agentCtx,
					identity,
					onMessage: config.onAgentMessage
						? async (msg: Message) => config.onAgentMessage?.(agentId, msg)
						: undefined,
				},
				ctrl.signal,
			)
				.catch((err) => {
					if (!ctrl.signal.aborted) {
						const errMsg = (err as Error).message;
						console.error(`[orchestrator] ${agentId} error: ${errMsg}`);
						config.onAgentError?.(agentId, errMsg);
						config.copilotMailboxRepo
							?.post({
								missionId: "copilot",
								from: "system",
								to: ["copilot"],
								subject: `Agent error: ${agentId}`,
								body:
									`Agent "${agentId}" in mission "${missionId}" encountered an error: ` +
									`${errMsg}`,
							})
							.catch((e: Error) =>
								console.error(
									`[orchestrator] failed to post copilot alert: ${e.message}`,
								),
							);
					}
				})
				.finally(() => {
					clearTimeout(runTimeoutId);
					signal?.removeEventListener("abort", onParentAbort);
					active.delete(agentId);
					activePromises.delete(agentId);
					config.onAgentDone?.(agentId);
					void checkIdle();
				});

			activePromises.set(agentId, promise);
			// No await — concurrent fire-and-forget dispatch.
		}
	}

	try {
		// Initial dispatch — run all agents with pending mail.
		await dispatchReady();

		if (config.waitForMail) {
			// Daemon mode: the Change Stream drives re-dispatch.
			// waitForMail() blocks until a mailbox insert fires (user→agent or agent→agent).
			while (!signal?.aborted && totalRuns < maxRuns) {
				try {
					await config.waitForMail();
				} catch {
					break; // Change Stream error or abort
				}
				if (signal?.aborted) break;
				await dispatchReady();
			}
		} else {
			// CLI mode: drain all work, then exit or offer TTY prompt.
			while (!signal?.aborted) {
				// Wait for all currently running agents to complete.
				const snapshot = [...activePromises.values()];
				if (snapshot.length > 0) {
					await Promise.allSettled(snapshot);
					// Re-dispatch: agents may have posted mail to each other during their run.
					await dispatchReady();
					continue;
				}

				// No active agents — check for remaining unread mail.
				if (await anyAgentHasUnreadMail()) {
					await dispatchReady();
					// If nothing was dispatched (maxRuns cap or all agents paused), stop.
					if (active.size === 0) break;
					continue;
				}

				// Truly idle — offer TTY prompt or exit.
				if (rl) {
					const input = await promptUser(
						rl,
						"Mission paused. Type a message to continue, or press Enter to end: ",
					);
					if (input) {
						const body = await processUserInput(input, workdir);
						if (body) {
							await mailboxRepo.post({
								missionId,
								from: "user",
								to: [leadAgent.id],
								subject: "User message",
								body,
							});
							await dispatchReady();
							continue;
						}
					}
				}
				break; // Natural termination.
			}
		}

		// Shutdown: abort all running agents and wait for clean exit.
		for (const ctrl of active.values()) ctrl.abort();
		await Promise.allSettled([...activePromises.values()]);

		console.log(`\n[orchestrator] Mission complete (${totalRuns} run(s))`);
	} finally {
		rl?.close();
		if (config.teardownOnExit) {
			workspaceManager.teardown(teamConfig.mission.id, identities);
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function promptUser(rl: readline.Interface, prompt: string): Promise<string> {
	return new Promise((resolve) => {
		rl.question(prompt, (answer) => resolve(answer.trim()));
	});
}
