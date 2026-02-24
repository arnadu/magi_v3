import type { TeamConfig } from "@magi/agent-config";
import type { Message, Model } from "@mariozechner/pi-ai";
import type { AgentIdentity } from "./identity.js";
import { runInnerLoop } from "./loop.js";
import type { MailboxMessage, MailboxRepository } from "./mailbox.js";
import { createMailboxTools } from "./mailbox.js";
import type { MentalMapRepository } from "./mental-map.js";
import { createMentalMapTool, initMentalMap } from "./mental-map.js";
import { buildSystemPrompt, formatMessages } from "./prompt.js";
import { createFetchUrlTool } from "./tools/fetch-url.js";
import { createInspectImageTool } from "./tools/inspect-image.js";
import { tryCreateSearchWebTool } from "./tools/search-web.js";
import type { AclPolicy } from "./tools.js";
import { createFileTools } from "./tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentRunContext {
	model: Model<string>;
	teamConfig: TeamConfig;
	mailboxRepo: MailboxRepository;
	mentalMapRepo: MentalMapRepository;
	/**
	 * Fallback working directory when no identity is provided.
	 * All agents share this when workspace isolation is not configured.
	 */
	workdir: string;
	/**
	 * When provided, this agent gets its own private workdir and ACL enforcement.
	 * Set by the orchestrator after workspace provisioning (Sprint 4+).
	 */
	identity?: AgentIdentity;
	/** Called immediately when the agent posts a message to "user". */
	onUserMessage?: (msg: MailboxMessage) => void;
	/** Called for every message produced by the inner loop (for logging/streaming). */
	onMessage?: (msg: Message, allMessages: Message[]) => Promise<void>;
}

// ---------------------------------------------------------------------------
// runAgent
// ---------------------------------------------------------------------------

/**
 * Run a single agent cycle: build prompt → inject messages → execute loop.
 *
 * When an AgentIdentity is provided in ctx, the agent uses its own private
 * workdir and all file tool operations are checked against its permittedPaths.
 */
export async function runAgent(
	agentId: string,
	messages: MailboxMessage[],
	ctx: AgentRunContext,
	signal?: AbortSignal,
): Promise<void> {
	const agent = ctx.teamConfig.agents.find((a) => a.id === agentId);
	if (!agent) throw new Error(`Agent "${agentId}" not found in team config`);

	// Use identity workdir if available, fall back to shared workdir.
	const workdir = ctx.identity?.workdir ?? ctx.workdir;
	const sharedArtifactsDir = ctx.identity?.sharedArtifactsDir;

	// Build ACL policy if the agent has an identity.
	const acl: AclPolicy | undefined = ctx.identity
		? { agentId, permittedPaths: ctx.identity.permittedPaths }
		: undefined;

	// Initialise mental map if this agent has never run before.
	let mentalMapHtml = await ctx.mentalMapRepo.load(agentId);
	if (!mentalMapHtml) {
		mentalMapHtml = initMentalMap(agent);
		await ctx.mentalMapRepo.save(agentId, mentalMapHtml);
	}

	const systemPrompt = buildSystemPrompt(agent, mentalMapHtml);
	const task = formatMessages(messages);

	const searchWebTool = tryCreateSearchWebTool();
	const tools = [
		...createFileTools(workdir, acl),
		...createMailboxTools(ctx.mailboxRepo, ctx.teamConfig, agentId, {
			onUserMessage: ctx.onUserMessage,
		}),
		createMentalMapTool(ctx.mentalMapRepo, agentId),
		createFetchUrlTool(workdir, ctx.model, sharedArtifactsDir),
		createInspectImageTool(workdir, ctx.model),
		...(searchWebTool ? [searchWebTool] : []),
	];

	await runInnerLoop({
		model: ctx.model,
		systemPrompt,
		task,
		tools,
		signal,
		onMessage: ctx.onMessage,
	});
}
