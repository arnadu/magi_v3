import type { TeamConfig } from "@magi/agent-config";
import type { Message, Model } from "@mariozechner/pi-ai";
import type { ConversationRepository } from "./conversation-repository.js";
import { runInnerLoop } from "./loop.js";
import type { MailboxMessage, MailboxRepository } from "./mailbox.js";
import { createMailboxTools } from "./mailbox.js";
import type { MentalMapRepository } from "./mental-map.js";
import { createMentalMapTool, initMentalMap } from "./mental-map.js";
import { buildSystemPrompt, formatMessages } from "./prompt.js";
import { tryCreateBrowseWebTool } from "./tools/browse-web.js";
import { createFetchUrlTool } from "./tools/fetch-url.js";
import { createInspectImageTool } from "./tools/inspect-image.js";
import { tryCreateSearchWebTool } from "./tools/search-web.js";
import type { AclPolicy } from "./tools.js";
import { createFileTools } from "./tools.js";
import type { AgentIdentity } from "./workspace-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentRunContext {
	model: Model<string>;
	teamConfig: TeamConfig;
	mailboxRepo: MailboxRepository;
	mentalMapRepo: MentalMapRepository;
	conversationRepo: ConversationRepository;
	/** Per-agent workspace identity providing private workdir and ACL. */
	identity: AgentIdentity;
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
 * The agent uses its private workdir and all file tool operations are checked
 * against its permittedPaths (ACL enforcement).
 */
export async function runAgent(
	agentId: string,
	messages: MailboxMessage[],
	ctx: AgentRunContext,
	signal?: AbortSignal,
): Promise<void> {
	const agent = ctx.teamConfig.agents.find((a) => a.id === agentId);
	if (!agent) throw new Error(`Agent "${agentId}" not found in team config`);

	const { workdir, sharedDir, linuxUser } = ctx.identity;
	const permittedPaths = [workdir, sharedDir];

	// linuxUser comes from ctx.identity — the authoritative source provisioned by
	// WorkspaceManager. Tool execution always runs as this OS user via sudo.
	const acl: AclPolicy = {
		agentId,
		permittedPaths,
		linuxUser,
	};

	const missionId = ctx.teamConfig.mission.id;

	// Load conversation history from previous wakeups.
	const history = await ctx.conversationRepo.load(agentId, missionId);
	const previousMessages = history.map((s) => s.message);
	const nextTurnNumber =
		history.reduce((max, s) => Math.max(max, s.turnNumber), -1) + 1;

	// Initialise mental map if this agent has never run before.
	let mentalMapHtml = await ctx.mentalMapRepo.load(agentId);
	if (!mentalMapHtml) {
		mentalMapHtml = initMentalMap(agent);
		await ctx.mentalMapRepo.save(agentId, mentalMapHtml);
	}

	const systemPrompt = buildSystemPrompt(
		agent,
		mentalMapHtml,
		sharedDir,
		workdir,
	);
	const task = formatMessages(messages);

	const searchWebTool = tryCreateSearchWebTool();
	// BrowseWebHandle is created here (once per agent turn) so all execute() calls
	// within the same runInnerLoop share one browser session (cookies, auth, history).
	const browseWebHandle = tryCreateBrowseWebTool(ctx.model, sharedDir);

	const tools = [
		...createFileTools(workdir, acl),
		...createMailboxTools(ctx.mailboxRepo, ctx.teamConfig, agentId, {
			onUserMessage: ctx.onUserMessage,
		}),
		createMentalMapTool(ctx.mentalMapRepo, agentId),
		createFetchUrlTool(ctx.model, sharedDir),
		createInspectImageTool(workdir, ctx.model, [sharedDir]),
		...(searchWebTool ? [searchWebTool] : []),
		...(browseWebHandle ? [browseWebHandle.tool] : []),
	];

	try {
		const result = await runInnerLoop({
			model: ctx.model,
			systemPrompt,
			task,
			tools,
			signal,
			previousMessages,
			onMessage: ctx.onMessage,
		});

		// Append only the new messages produced this turn (slice off previousMessages).
		const newMessages = result.messages.slice(previousMessages.length);
		await ctx.conversationRepo.append(
			agentId,
			missionId,
			newMessages.map((message) => ({ turnNumber: nextTurnNumber, message })),
		);
	} finally {
		// Close the browser session regardless of success or failure.
		await browseWebHandle?.close();
	}
}
