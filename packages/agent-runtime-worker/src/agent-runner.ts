import type { TeamConfig } from "@magi/agent-config";
import type { AssistantMessage, Message, Model } from "@mariozechner/pi-ai";
import type {
	ConversationRepository,
	SummaryMessage,
} from "./conversation-repository.js";
import type { LlmCallLogRepository } from "./llm-call-log.js";
import { computeCost, truncateToolBodies } from "./llm-call-log.js";
import { runInnerLoop } from "./loop.js";
import type { MailboxMessage, MailboxRepository } from "./mailbox.js";
import { createMailboxTools } from "./mailbox.js";
import type { MentalMapRepository } from "./mental-map.js";
import { createMentalMapTool, initMentalMap } from "./mental-map.js";
import { buildSystemPrompt, formatMessages } from "./prompt.js";
import { convertToLlm, runReflection } from "./reflection.js";
import { tryCreateBrowseWebTool } from "./tools/browse-web.js";
import { createFetchUrlTool } from "./tools/fetch-url.js";
import { createInspectImageTool } from "./tools/inspect-image.js";
import { createResearchTool } from "./tools/research.js";
import { tryCreateSearchWebTool } from "./tools/search-web.js";
import type { AclPolicy } from "./tools.js";
import { createFileTools } from "./tools.js";
import type { AgentIdentity } from "./workspace-manager.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Input token limit for Claude Sonnet 4.6. */
const CTX_LIMIT = 200_000;

/**
 * Reflection is only run when the last LLM call in the previous session used
 * at least this fraction of the context window. Sessions smaller than this
 * threshold are too cheap to justify a separate reflection call.
 */
const REFLECTION_CTX_THRESHOLD = 0.6 * CTX_LIMIT; // 120 000 tokens

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentRunContext {
	model: Model<string>;
	teamConfig: TeamConfig;
	mailboxRepo: MailboxRepository;
	mentalMapRepo: MentalMapRepository;
	conversationRepo: ConversationRepository;
	/** Optional LLM call audit log — written for every LLM call including reflection. */
	llmCallLog?: LlmCallLogRepository;
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
	let history = await ctx.conversationRepo.load(agentId, missionId);

	// Reflect on the previous session before starting this one (skip on first wakeup).
	// sessionMessages are the full raw messages from the previous session — no
	// content is collapsed here; compaction applies only via the repository's
	// compact() call inside runReflection, which marks old docs as compacted so
	// they are excluded from future load() calls.
	const nonSummaryHistory = history.filter((sm) => sm.message.role !== "summary");
	const sessionMessages = nonSummaryHistory.map((sm) => sm.message as Message);

	const lastAssistantUsage = [...sessionMessages]
		.reverse()
		.find((m): m is AssistantMessage => m.role === "assistant")
		?.usage as { input: number } | undefined;
	const peakInputTokens = lastAssistantUsage?.input ?? 0;

	/**
	 * Build the onLlmCall handler for a given turnNumber and isReflection flag.
	 * Writes one entry to llmCallLog per LLM response if a log repo is configured.
	 */
	const makeOnLlmCall = (turnNumber: number, isReflection: boolean) =>
		ctx.llmCallLog
			? async (event: {
					systemPrompt: string;
					messages: Message[];
					toolNames: string[];
					response: AssistantMessage;
			  }) => {
					const usage = event.response.usage as {
						input: number;
						output: number;
						cacheRead: number;
						cacheWrite: number;
					};
					const modelCost = ctx.model.cost as {
						input: number;
						output: number;
						cacheRead: number;
						cacheWrite: number;
					};
					await ctx.llmCallLog!.append({
						missionId,
						agentId,
						turnNumber,
						isReflection,
						savedAt: new Date(),
						model: ctx.model.id,
						input: {
							systemPrompt: event.systemPrompt,
							messages: truncateToolBodies(event.messages),
							toolNames: event.toolNames,
						},
						output: {
							message: event.response,
							stopReason: event.response.stopReason,
						},
						usage: {
							inputTokens: usage.input,
							outputTokens: usage.output,
							cacheReadTokens: usage.cacheRead,
							cacheWriteTokens: usage.cacheWrite,
							cost: computeCost(usage, modelCost),
						},
					});
			  }
			: undefined;

	if (sessionMessages.length > 0 && peakInputTokens >= REFLECTION_CTX_THRESHOLD) {
		const lastTurnNumber = nonSummaryHistory.reduce(
			(max, sm) => Math.max(max, sm.turnNumber),
			-1,
		);
		const previousSummaries = history
			.filter((sm) => sm.message.role === "summary")
			.map((sm) => (sm.message as SummaryMessage).content);
		await runReflection(agentId, missionId, sessionMessages, {
			model: ctx.model,
			mentalMapRepo: ctx.mentalMapRepo,
			conversationRepo: ctx.conversationRepo,
			turnNumber: lastTurnNumber,
			previousSummaries,
			onMessage: ctx.onMessage
				? (msg) => ctx.onMessage!(msg, [])
				: undefined,
			onLlmCall: makeOnLlmCall(lastTurnNumber + 1, true),
		});
		// Reload: compacted docs are now excluded and the new summary is visible.
		history = await ctx.conversationRepo.load(agentId, missionId);
	}

	const nextTurnNumber =
		history.reduce((max, s) => Math.max(max, s.turnNumber), -1) + 1;
	const previousMessages = convertToLlm(history);

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

	// Debug: print context passed to the LLM at session start.
	// Enable with DEBUG_SESSIONS=1 in the environment.
	if (process.env.DEBUG_SESSIONS === "1") {
		const sep = "═".repeat(72);
		console.log(`\n${sep}`);
		console.log(`[DEBUG] Agent: ${agentId}  Turn: ${nextTurnNumber}`);
		console.log(`${sep}`);
		console.log("[DEBUG] SYSTEM PROMPT:\n");
		console.log(systemPrompt);
		if (previousMessages.length > 0) {
			console.log(`\n${"─".repeat(72)}`);
			console.log("[DEBUG] PREVIOUS MESSAGES (passed as prior context):\n");
			for (const m of previousMessages) {
				const preview =
					typeof m.content === "string"
						? m.content.slice(0, 500)
						: JSON.stringify(m.content).slice(0, 500);
				console.log(`  [${m.role}] ${preview}${preview.length >= 500 ? "…" : ""}`);
			}
		} else {
			console.log("\n[DEBUG] PREVIOUS MESSAGES: (none — first session)");
		}
		console.log(`${sep}\n`);
	}

	const searchWebTool = tryCreateSearchWebTool();
	// BrowseWebHandle is created here (once per agent turn) so all execute() calls
	// within the same runInnerLoop share one browser session (cookies, auth, history).
	const browseWebHandle = tryCreateBrowseWebTool(ctx.model, sharedDir);

	// Research sub-loop Bash is restricted to sharedDir only (no workdir).
	// This lets it read existing artifacts and the research index without
	// touching the agent's private workspace or running git/write operations.
	const researchAcl: AclPolicy = {
		agentId,
		permittedPaths: [sharedDir],
		linuxUser,
	};

	const tools = [
		...createFileTools(workdir, acl),
		...createMailboxTools(ctx.mailboxRepo, ctx.teamConfig, agentId, {
			onUserMessage: ctx.onUserMessage,
		}),
		createMentalMapTool(ctx.mentalMapRepo, agentId),
		createFetchUrlTool(ctx.model, sharedDir),
		createInspectImageTool(workdir, ctx.model, [sharedDir]),
		createResearchTool(ctx.model, sharedDir, researchAcl),
		...(searchWebTool ? [searchWebTool] : []),
		...(browseWebHandle ? [browseWebHandle.tool] : []),
	];

	try {
		await runInnerLoop({
			model: ctx.model,
			systemPrompt,
			task,
			tools,
			signal,
			previousMessages,
			// Persist each message immediately as it arrives so a mid-session crash
			// does not lose completed work. onMessage does not fire for previousMessages
			// (already persisted), so there is no risk of duplicates.
			onMessage: async (msg, allMessages) => {
				await ctx.conversationRepo.append(agentId, missionId, [
					{ turnNumber: nextTurnNumber, message: msg },
				]);
				await ctx.onMessage?.(msg, allMessages);
			},
			onLlmCall: makeOnLlmCall(nextTurnNumber, false),
		});
	} finally {
		// Close the browser session regardless of success or failure.
		await browseWebHandle?.close();
	}
}
