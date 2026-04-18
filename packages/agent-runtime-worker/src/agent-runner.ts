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
 * Override via REFLECTION_THRESHOLD env var (tokens) for testing.
 */
const REFLECTION_CTX_THRESHOLD = process.env.REFLECTION_THRESHOLD
	? Number.parseInt(process.env.REFLECTION_THRESHOLD, 10)
	: 0.6 * CTX_LIMIT; // 120 000 tokens

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentRunContext {
	model: Model<string>;
	/**
	 * Secondary model for vision-only tasks: FetchUrl image captioning,
	 * InspectImage, and BrowseWeb. Defaults to model when absent.
	 */
	visionModel?: Model<string>;
	teamConfig: TeamConfig;
	mailboxRepo: MailboxRepository;
	conversationRepo: ConversationRepository;
	/** Optional LLM call audit log — written for every LLM call including reflection. */
	llmCallLog?: LlmCallLogRepository;
	/** Per-agent workspace identity providing private workdir and ACL. */
	identity: AgentIdentity;
	/** Called immediately when the agent posts a message to "user". */
	onUserMessage?: (msg: MailboxMessage) => void;
	/** Called for every message produced by the inner loop (for logging/streaming). */
	onMessage?: (msg: Message, allMessages: Message[]) => Promise<void>;
	/** Called when UpdateMentalMap changes the agent's mental map. Used for SSE push to dashboard. */
	onMentalMapUpdate?: (agentId: string, html: string) => void;
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

	// Peak input tokens across all LLM calls in the previous session.
	// Using max (not just the last call) because some models produce shorter
	// final calls after long intermediate tool-result contexts.
	const peakInputTokens = sessionMessages
		.filter((m): m is AssistantMessage => m.role === "assistant")
		.reduce((max, m) => Math.max(max, ((m.usage as { input?: number })?.input ?? 0)), 0);

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

	// Load mental map from the most recent AssistantMessage snapshot in conversationMessages.
	// Falls back to initMentalMap if this is the first wakeup.
	let currentMentalMapHtml: string =
		(await ctx.conversationRepo.loadMostRecentMentalMap(agentId, missionId))
		?? initMentalMap(agent);

	// Read threshold lazily so REFLECTION_THRESHOLD env var set by tests is honoured.
	const reflectionThreshold = process.env.REFLECTION_THRESHOLD
		? Number.parseInt(process.env.REFLECTION_THRESHOLD, 10)
		: REFLECTION_CTX_THRESHOLD;
	if (sessionMessages.length > 0 && peakInputTokens >= reflectionThreshold) {
		const lastTurnNumber = nonSummaryHistory.reduce(
			(max, sm) => Math.max(max, sm.turnNumber),
			-1,
		);
		const previousSummaries = history
			.filter((sm) => sm.message.role === "summary")
			.map((sm) => (sm.message as SummaryMessage).content);
		await runReflection(agentId, missionId, sessionMessages, {
			model: ctx.model,
			getMentalMap: () => currentMentalMapHtml,
			setMentalMap: (html) => {
				currentMentalMapHtml = html;
				ctx.onMentalMapUpdate?.(agentId, html);
			},
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

	// Track which LLM call within this session we're on.
	// -1 = task user message (before first LLM call); increments to 0, 1, 2… on each AssistantMessage.
	let currentCallSeq = -1;

	// Getter so the inner loop rebuilds the system prompt each iteration (picks up UpdateMentalMap changes).
	const getSystemPrompt = () =>
		buildSystemPrompt(agent, currentMentalMapHtml, sharedDir, workdir);

	const task = formatMessages(messages);

	// Debug: print context passed to the LLM at session start.
	// Enable with DEBUG_SESSIONS=1 in the environment.
	if (process.env.DEBUG_SESSIONS === "1") {
		const sep = "═".repeat(72);
		console.log(`\n${sep}`);
		console.log(`[DEBUG] Agent: ${agentId}  Turn: ${nextTurnNumber}`);
		console.log(`${sep}`);
		console.log("[DEBUG] SYSTEM PROMPT:\n");
		console.log(getSystemPrompt());
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

	const visionModel = ctx.visionModel ?? ctx.model;

	const searchWebTool = tryCreateSearchWebTool();
	// BrowseWebHandle is created here (once per agent turn) so all execute() calls
	// within the same runInnerLoop share one browser session (cookies, auth, history).
	const browseWebHandle = tryCreateBrowseWebTool(visionModel, sharedDir);

	// Research sub-loop Bash is restricted to sharedDir only (no workdir).
	// This lets it read existing artifacts and the research index without
	// touching the agent's private workspace or running git/write operations.
	const researchAcl: AclPolicy = {
		agentId,
		permittedPaths: [sharedDir],
		linuxUser,
	};

	const appendSubLoop = async (toolUseId: string, msg: Message) => {
		await ctx.conversationRepo.append(agentId, missionId, [{
			turnNumber: nextTurnNumber,
			callSeq: currentCallSeq,
			parentToolUseId: toolUseId,
			message: msg,
		}]);
	};

	const tools = [
		...createFileTools(workdir, acl),
		...createMailboxTools(ctx.mailboxRepo, ctx.teamConfig, agentId, {
			onUserMessage: ctx.onUserMessage,
		}),
		createMentalMapTool(
			() => currentMentalMapHtml,
			(html) => {
				currentMentalMapHtml = html;
				ctx.onMentalMapUpdate?.(agentId, html);
			},
		),
		createFetchUrlTool(visionModel, sharedDir),
		createInspectImageTool(workdir, visionModel, [sharedDir]),
		createResearchTool(ctx.model, sharedDir, researchAcl, { onSubLoopMessage: appendSubLoop }),
		...(searchWebTool ? [searchWebTool] : []),
		...(browseWebHandle ? [browseWebHandle.tool] : []),
	];

	try {
		await runInnerLoop({
			model: ctx.model,
			getSystemPrompt,
			task,
			tools,
			signal,
			previousMessages,
			// Persist each message immediately as it arrives so a mid-session crash
			// does not lose completed work. onMessage does not fire for previousMessages
			// (already persisted), so there is no risk of duplicates.
			onMessage: async (msg, allMessages) => {
				if (msg.role === "assistant") {
					// Increment callSeq first, then capture the current mental map HTML
					// (which is what was in the system prompt for this LLM call — UpdateMentalMap
					// runs after AssistantMessage is pushed, so currentMentalMapHtml is the
					// pre-tool-execution state).
					currentCallSeq++;
					const snapshotHtml = currentMentalMapHtml;
					await ctx.conversationRepo.append(agentId, missionId, [
						{
							turnNumber: nextTurnNumber,
							callSeq: currentCallSeq,
							mentalMapHtml: snapshotHtml,
							message: msg,
						},
					]);
				} else {
					// user task message (callSeq -1) or toolResult (callSeq = current)
					await ctx.conversationRepo.append(agentId, missionId, [
						{
							turnNumber: nextTurnNumber,
							callSeq: currentCallSeq,
							message: msg,
						},
					]);
				}
				await ctx.onMessage?.(msg, allMessages);
			},
			onLlmCall: makeOnLlmCall(nextTurnNumber, false),
		});
	} finally {
		// Close the browser session regardless of success or failure.
		await browseWebHandle?.close();
	}
}
