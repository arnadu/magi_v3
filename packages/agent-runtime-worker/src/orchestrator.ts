import * as readline from "node:readline";
import type { TeamConfig } from "@magi/agent-config";
import type { Message, Model } from "@mariozechner/pi-ai";
import { runAgent } from "./agent-runner.js";
import type { ConversationRepository } from "./conversation-repository.js";
import type { LlmCallLogRepository } from "./llm-call-log.js";
import type { MailboxMessage, MailboxRepository } from "./mailbox.js";
import { verifyIsolation } from "./tools.js";
import { processUserInput } from "./user-input.js";
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
	model: Model<string>;
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
	 * Max orchestration cycles before aborting.
	 * One cycle = one pass through all agents with unread mail.
	 * Default: 50.
	 */
	maxCycles?: number;
	/**
	 * If true, pause after each runAgent() call and prompt the operator to
	 * continue or inject a message. Useful during development.
	 */
	step?: boolean;
	/** Called immediately when an agent posts a message to "user". */
	onUserMessage?: (msg: MailboxMessage) => void;
	/** Called for every inner-loop message produced by any agent (for logging/streaming). */
	onAgentMessage?: (agentId: string, msg: Message) => void;
	/**
	 * Called just before an agent is about to run.
	 * `pending` lists the agents that will run later in this same cycle
	 * (not including agentId itself). The monitor uses this to show the queue.
	 */
	onAgentStart?: (agentId: string, pending: string[]) => void;
	/** Called immediately after an agent's loop returns. */
	onAgentDone?: (agentId: string) => void;
	/** Called when an agent's mental map is updated (for SSE push to dashboard). */
	onMentalMapUpdate?: (agentId: string, html: string) => void;
	/** Called when the cycle is empty and the loop is about to sleep on waitForMail. */
	onIdle?: () => void;
	/**
	 * When provided, called instead of breaking when inbox is empty.
	 * The daemon supplies a Change Stream watch that resolves when a new
	 * MailboxMessage is inserted. After it resolves, the loop continues.
	 * When absent (cli.ts / tests), the loop exits on empty inbox.
	 */
	waitForMail?: () => Promise<void>;
	/**
	 * When provided, called before every agent turn. Resolves immediately when
	 * step mode is off; blocks until the operator clicks "Run" in the monitor
	 * dashboard (or calls POST /step) when step mode is on.
	 * This hook takes priority over the TTY readline step mode.
	 */
	waitForStep?: () => Promise<void>;
	/**
	 * When provided, called after every agent turn. Resolves immediately when
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
}

// ---------------------------------------------------------------------------
// runOrchestrationLoop
// ---------------------------------------------------------------------------

/**
 * Sequential orchestration loop.
 *
 * Scheduling rule: an agent runs when it has unread messages in its inbox.
 * The loop terminates when no agent has unread messages, or when maxCycles
 * is reached, or when the AbortSignal fires.
 *
 * The workspaceManager provisions per-agent private directories and ACL
 * enforcement before the first cycle and tears them down on exit.
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
		workdir,
		step = false,
		onUserMessage,
		workspaceManager,
	} = config;
	const maxCycles = config.maxCycles ?? 50;

	const leadAgent = teamConfig.agents[0];
	if (!leadAgent) throw new Error("Team config must have at least one agent");

	// Provision workspace for all agents.
	// linuxUser is required in the team YAML — validated by the config loader.
	const agentDefs = teamConfig.agents.map((a) => ({
		id: a.id,
		linuxUser: a.linuxUser,
	}));
	const identities = workspaceManager.provision(
		teamConfig.mission.id,
		agentDefs,
	);
	console.log(
		`[orchestrator] Workspace provisioned for ${identities.size} agent(s)`,
	);

	// Verify isolation invariant: ANTHROPIC_API_KEY must not be visible in
	// child processes. Fails fast if sudo is misconfigured or secrets leak.
	const firstIdentity = identities.get(agentDefs[0].id);
	if (!firstIdentity)
		throw new Error("No identity for first agent after provision");
	await verifyIsolation(firstIdentity.linuxUser, firstIdentity.workdir);
	console.log(
		"[orchestrator] Isolation verified — child env does not contain secrets",
	);

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
		teamConfig,
		mailboxRepo,
		conversationRepo,
		llmCallLog,
		onMentalMapUpdate: config.onMentalMapUpdate,
		onUserMessage: (msg: MailboxMessage) => {
			const timestamp = msg.timestamp.toISOString();
			console.log(`\n[→ USER from ${msg.from}] ${msg.subject} (${timestamp})`);
			console.log(msg.body);
			console.log();
			onUserMessage?.(msg);
		},
	};

	// Precompute supervisor-depth for every agent (depth 0 = reports to user).
	// Used to run senior agents before juniors within each cycle.
	const agentDepth = buildAgentDepths(teamConfig.agents);

	let cycles = 0;

	try {
		// eslint-disable-next-line no-constant-condition
		while (true) {
			if (signal?.aborted) break;

			// Drain buffered user input → post to lead's inbox.
			while (inputBuffer.length > 0) {
				const line = inputBuffer.shift() as string;
				const body = await processUserInput(line, workdir);
				if (!body) continue; // was a /command or empty
				await mailboxRepo.post({
					missionId: teamConfig.mission.id,
					from: "user",
					to: [leadAgent.id],
					subject: "User message",
					body,
				});
			}

			// Find agents with unread messages, seniors first.
			const agentsWithMail: string[] = [];
			for (const agent of teamConfig.agents) {
				if (await mailboxRepo.hasUnread(agent.id)) {
					agentsWithMail.push(agent.id);
				}
			}
			agentsWithMail.sort(
				(a, b) => (agentDepth.get(a) ?? 0) - (agentDepth.get(b) ?? 0),
			);

			if (agentsWithMail.length === 0) {
				config.onIdle?.();
				if (config.waitForMail) {
					// Daemon mode: sleep on Change Stream until a new message arrives.
					await config.waitForMail();
					continue;
				}
				// CLI mode: offer the operator a prompt.
				if (rl) {
					const input = await promptUser(
						rl,
						"Mission paused. Type a message to continue, or press Enter to end: ",
					);
					if (input) {
						const body = await processUserInput(input, workdir);
						if (body) {
							await mailboxRepo.post({
								missionId: teamConfig.mission.id,
								from: "user",
								to: [leadAgent.id],
								subject: "User message",
								body,
							});
						}
						continue; // restart the loop (even for /commands, re-check mail)
					}
				}
				break; // natural termination
			}

			if (cycles >= maxCycles) {
				console.warn(
					`[orchestrator] maxCycles (${maxCycles}) reached — aborting`,
				);
				break;
			}
			cycles++;

			// Run each agent with unread mail sequentially.
			for (let i = 0; i < agentsWithMail.length; i++) {
				const agentId = agentsWithMail[i];
				if (signal?.aborted) break;

				const messages = await mailboxRepo.listUnread(agentId);
				await mailboxRepo.markRead(
					messages.map((m) => m.id),
					agentId,
				);

				const agent = teamConfig.agents.find((a) => a.id === agentId);
				const identity = identities.get(agentId);
				if (!identity)
					throw new Error(`No workspace identity for agent "${agentId}"`);

				// Notify monitor of upcoming agent + remaining queue, then pause if in step mode.
				const pending = agentsWithMail.slice(i + 1);
				config.onAgentStart?.(agentId, pending);

				if (config.waitForStep) {
					// Web step mode — monitor shows agent name and "Run" button.
					await config.waitForStep();
				} else if (step && rl) {
					// TTY step mode — readline prompt before running.
					const input = await promptUser(
						rl,
						`[step] About to run ${agent?.name ?? agentId}. Press Enter or type a message: `,
					);
					if (input) {
						const body = await processUserInput(input, workdir);
						if (body) {
							await mailboxRepo.post({
								missionId: teamConfig.mission.id,
								from: "user",
								to: [leadAgent.id],
								subject: "User message",
								body,
							});
						}
					}
				}

				console.log(
					`\n[orchestrator] Running ${agent?.name ?? agentId}` +
						` (${identity.linuxUser}) (${messages.length} message(s))`,
				);

				await runAgent(
					agentId,
					messages,
					{
						...agentCtx,
						identity,
						onMessage: config.onAgentMessage
							? async (msg: Message) => config.onAgentMessage?.(agentId, msg)
							: undefined,
					},
					signal,
				);

				config.onAgentDone?.(agentId);

				// Budget gate — blocks between agent turns when spending cap is reached.
				// Resolves immediately when within budget; suspends until operator extends.
				if (config.waitForBudget) {
					await config.waitForBudget();
					if (signal?.aborted) break;
				}
			}
		}

		console.log(`\n[orchestrator] Mission complete (${cycles} cycle(s))`);
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

/**
 * Compute supervisor depth for each agent (depth 0 = supervisor is "user").
 * Used to run senior agents before juniors within a cycle.
 * Cycle-safe: a cycle in the supervisor graph is treated as depth 0.
 */
function buildAgentDepths(
	agents: { id: string; supervisor: string }[],
): Map<string, number> {
	const depths = new Map<string, number>();

	function depth(id: string, visiting: Set<string>): number {
		if (depths.has(id)) return depths.get(id) as number;
		if (visiting.has(id)) return 0; // cycle guard
		visiting.add(id);
		const agent = agents.find((a) => a.id === id);
		const d =
			!agent || agent.supervisor === "user"
				? 0
				: 1 + depth(agent.supervisor, visiting);
		depths.set(id, d);
		return d;
	}

	for (const agent of agents) depth(agent.id, new Set());
	return depths;
}
