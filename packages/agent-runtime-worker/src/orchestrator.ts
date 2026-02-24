import * as readline from "node:readline";
import type { TeamConfig } from "@magi/agent-config";
import type { Message, Model } from "@mariozechner/pi-ai";
import { runAgent } from "./agent-runner.js";
import type { AgentIdentity } from "./identity.js";
import type { MailboxMessage, MailboxRepository } from "./mailbox.js";
import type { MentalMapRepository } from "./mental-map.js";
import { processUserInput } from "./user-input.js";
import type { WorkspaceManager } from "./workspace-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
	teamConfig: TeamConfig;
	mailboxRepo: MailboxRepository;
	mentalMapRepo: MentalMapRepository;
	model: Model<string>;
	/** Base working directory. Used when workspaceManager is not configured. */
	workdir: string;
	/**
	 * When provided, the orchestrator provisions a workspace at startup,
	 * gives each agent its own private workdir with ACL enforcement, and
	 * tears the workspace down on exit.
	 */
	workspaceManager?: WorkspaceManager;
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
 * When a workspaceManager is provided, per-agent identity is resolved from
 * the provisioned workspace and ACL enforcement is active.
 */
export async function runOrchestrationLoop(
	config: OrchestratorConfig,
	signal?: AbortSignal,
): Promise<void> {
	const {
		teamConfig,
		mailboxRepo,
		mentalMapRepo,
		model,
		workdir,
		step = false,
		onUserMessage,
		workspaceManager,
	} = config;
	const maxCycles = config.maxCycles ?? 50;

	const leadAgent = teamConfig.agents[0];
	if (!leadAgent) throw new Error("Team config must have at least one agent");

	// Provision workspace if a manager is configured.
	let identities: Map<string, AgentIdentity> | undefined;
	if (workspaceManager) {
		const agentDefs = teamConfig.agents.map((a) => ({
			id: a.id,
			role: ((a as Record<string, unknown>).role as string) ?? "agent",
		}));
		identities = workspaceManager.provision(teamConfig.mission.id, agentDefs);
		console.log(
			`[orchestrator] Workspace provisioned for ${identities.size} agent(s)`,
		);
	}

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
		mentalMapRepo,
		workdir,
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
				// No unread messages — offer the operator a prompt.
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
			for (const agentId of agentsWithMail) {
				if (signal?.aborted) break;

				const messages = await mailboxRepo.listUnread(agentId);
				await mailboxRepo.markRead(
					messages.map((m) => m.id),
					agentId,
				);

				const agent = teamConfig.agents.find((a) => a.id === agentId);
				const identity = identities?.get(agentId);
				console.log(
					`\n[orchestrator] Running ${agent?.name ?? agentId}` +
						(identity ? ` (${identity.linuxUser})` : "") +
						` (${messages.length} message(s))`,
				);

				await runAgent(
					agentId,
					messages,
					{
						...agentCtx,
						identity,
						onMessage: config.onAgentMessage
							? async (msg: Message) => {
									config.onAgentMessage?.(agentId, msg);
								}
							: undefined,
					},
					signal,
				);

				if (step && rl) {
					const input = await promptUser(
						rl,
						`[step] ${agent?.name ?? agentId} done. Press Enter or type a message: `,
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
			}
		}
	} finally {
		rl?.close();
		// Teardown workspace if one was provisioned.
		if (workspaceManager && identities) {
			workspaceManager.teardown(teamConfig.mission.id, identities);
		}
	}

	console.log(`\n[orchestrator] Mission complete (${cycles} cycle(s))`);
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
