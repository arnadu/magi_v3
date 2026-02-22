import * as readline from "node:readline";
import type { TeamConfig } from "@magi/agent-config";
import type { Model } from "@mariozechner/pi-ai";
import { runAgent } from "./agent-runner.js";
import type { MailboxMessage, MailboxRepository } from "./mailbox.js";
import type { MentalMapRepository } from "./mental-map.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
	teamConfig: TeamConfig;
	mailboxRepo: MailboxRepository;
	mentalMapRepo: MentalMapRepository;
	model: Model<string>;
	/** Base working directory. All agents share this in Sprint 2. */
	workdir: string;
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
 * User interaction:
 * - Messages to "user" are surfaced immediately via onUserMessage.
 * - In step mode, the operator is prompted between agent runs.
 * - At natural termination, the operator is offered a prompt to inject a
 *   follow-up message (which restarts the loop) or end the session.
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
	} = config;
	const maxCycles = config.maxCycles ?? 50;

	const leadAgent = teamConfig.agents[0];
	if (!leadAgent) throw new Error("Team config must have at least one agent");

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

	let cycles = 0;

	try {
		// eslint-disable-next-line no-constant-condition
		while (true) {
			if (signal?.aborted) break;

			// Drain buffered user input → post to lead's inbox.
			while (inputBuffer.length > 0) {
				const line = inputBuffer.shift() as string;
				await mailboxRepo.post({
					missionId: teamConfig.mission.id,
					from: "user",
					to: [leadAgent.id],
					subject: "User message",
					body: line,
				});
			}

			// Find agents with unread messages.
			const agentsWithMail: string[] = [];
			for (const agent of teamConfig.agents) {
				if (await mailboxRepo.hasUnread(agent.id)) {
					agentsWithMail.push(agent.id);
				}
			}

			if (agentsWithMail.length === 0) {
				// No unread messages — offer the operator a prompt.
				if (rl) {
					const input = await promptUser(
						rl,
						"Mission paused. Type a message to continue, or press Enter to end: ",
					);
					if (input) {
						await mailboxRepo.post({
							missionId: teamConfig.mission.id,
							from: "user",
							to: [leadAgent.id],
							subject: "User message",
							body: input,
						});
						continue; // restart the loop with the new message
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
				console.log(
					`\n[orchestrator] Running ${agent?.name ?? agentId} (${messages.length} message(s))`,
				);

				await runAgent(agentId, messages, agentCtx, signal);

				if (step && rl) {
					const input = await promptUser(
						rl,
						`[step] ${agent?.name ?? agentId} done. Press Enter or type a message: `,
					);
					if (input) {
						await mailboxRepo.post({
							missionId: teamConfig.mission.id,
							from: "user",
							to: [leadAgent.id],
							subject: "User message",
							body: input,
						});
					}
				}
			}
		}
	} finally {
		rl?.close();
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
