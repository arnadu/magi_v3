import type { TeamConfig } from "@magi/agent-config";
import type { Model } from "@mariozechner/pi-ai";
import { runInnerLoop } from "./loop.js";
import type { MailboxMessage, MailboxRepository } from "./mailbox.js";
import { createMailboxTools } from "./mailbox.js";
import type { MentalMapRepository } from "./mental-map.js";
import { createMentalMapTool, initMentalMap } from "./mental-map.js";
import { buildSystemPrompt, formatMessages } from "./prompt.js";
import { createFileTools } from "./tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentRunContext {
	model: Model<string>;
	teamConfig: TeamConfig;
	mailboxRepo: MailboxRepository;
	mentalMapRepo: MentalMapRepository;
	/** Working directory for file tools. All agents share this in Sprint 2. */
	workdir: string;
	/** Called immediately when the agent posts a message to "user". */
	onUserMessage?: (msg: MailboxMessage) => void;
}

// ---------------------------------------------------------------------------
// runAgent
// ---------------------------------------------------------------------------

/**
 * Run a single agent cycle: build prompt → inject messages → execute loop.
 *
 * The orchestrator calls this function and knows nothing about what happens
 * inside. Sprint 3 will wrap this as a Temporal Activity unchanged.
 */
export async function runAgent(
	agentId: string,
	messages: MailboxMessage[],
	ctx: AgentRunContext,
	signal?: AbortSignal,
): Promise<void> {
	const agent = ctx.teamConfig.agents.find((a) => a.id === agentId);
	if (!agent) throw new Error(`Agent "${agentId}" not found in team config`);

	// Initialise mental map if this agent has never run before.
	let mentalMapHtml = await ctx.mentalMapRepo.load(agentId);
	if (!mentalMapHtml) {
		mentalMapHtml = initMentalMap(agent, ctx.teamConfig);
		await ctx.mentalMapRepo.save(agentId, mentalMapHtml);
	}

	const systemPrompt = buildSystemPrompt(agent, ctx.teamConfig, mentalMapHtml);
	const task = formatMessages(messages);

	const tools = [
		...createFileTools(ctx.workdir),
		...createMailboxTools(ctx.mailboxRepo, ctx.teamConfig, agentId, {
			onUserMessage: ctx.onUserMessage,
		}),
		createMentalMapTool(ctx.mentalMapRepo, agentId),
	];

	await runInnerLoop({
		model: ctx.model,
		systemPrompt,
		task,
		tools,
		signal,
	});
}
