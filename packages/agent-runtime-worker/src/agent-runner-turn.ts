/**
 * The stateful phases of one agent turn, called in order by `runAgent`
 * (agent-runner.ts): prepare (history, reflection, mental map, turn number),
 * assemble tools, build the loop hooks, run the loop with the
 * conversation-recovery retry. What they share lives in one `TurnState`
 * object, so each closure reads the current value instead of a captured copy.
 */

import type { AgentConfig } from "@magi/agent-config";
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import {
	type AgentRunContext,
	forceCompactSession,
	isConversationStructureError,
} from "./agent-runner.js";
import type { createLlmCallHook } from "./agent-runner-llm-log.js";
import {
	createLimitEnforcer,
	syncObjectivesSection,
} from "./agent-runner-phases.js";
import type { LlmCallEvent, LlmCallMeter } from "./llm-meter.js";
import { type InnerLoopConfig, runInnerLoop } from "./loop.js";
import { createMailboxTools } from "./mailbox.js";
import { createMentalMapTools, initMentalMap } from "./mental-map.js";
import { createObjectivesTools } from "./objectives/tools.js";
import {
	convertToLlm,
	loadRepairedHistory,
	reflectGuarded,
	reflectSession,
	shouldReflect,
} from "./reflection.js";
import { createAnalyzeMemoriesTool } from "./tools/analyze-memories.js";
import { tryCreateBrowseWebTool } from "./tools/browse-web.js";
import { createFetchUrlTool } from "./tools/fetch-url.js";
import { createInspectImageTool } from "./tools/inspect-image.js";
import { createResearchTool } from "./tools/research.js";
import { tryCreateSearchWebTool } from "./tools/search-web.js";
import type { AclPolicy, MagiTool } from "./tools.js";
import { createFileTools } from "./tools.js";

/** Input token limit used when the model does not declare its context window. */
const CTX_LIMIT = 200_000;

/** The values several phases and closures of one turn read and write. */
export interface TurnState {
	mentalMapHtml: string;
	/** Conversation turn; the recovery retry moves it past the compacted history. */
	turnNumber: number;
	/** Which LLM call of the turn we are on: -1 before the first, then 0, 1, 2… */
	callSeq: number;
	postedToSupervisor: boolean;
	/** The last non-empty text reply, for the supervisor fallback. */
	lastAssistantText: string;
}

type MakeOnLlmCall = ReturnType<typeof createLlmCallHook>;
type OnLlmCall = (event: LlmCallEvent) => Promise<void>;

export interface PreparedTurn {
	state: TurnState;
	previousMessages: Message[];
	reflectionTriggered: boolean;
}

/**
 * Load the conversation and the mental map, reflect on the previous session
 * if it is due (never on a first wakeup), pick the turn number and sync the
 * daemon-managed objectives section into the mental map.
 */
export async function prepareTurn(
	ctx: AgentRunContext,
	agent: AgentConfig,
	missionId: string,
	makeOnLlmCall: MakeOnLlmCall,
): Promise<PreparedTurn> {
	const agentId = agent.id;
	const { workdir, sharedDir } = ctx.identity;
	let history = await loadRepairedHistory(
		ctx.conversationRepo,
		agentId,
		missionId,
	);
	// The previous session's raw messages; compaction happens only through the
	// repository's compact() inside reflection.
	const nonSummaryHistory = history.filter(
		(sm) => sm.message.role !== "summary",
	);
	const sessionMessages = nonSummaryHistory.map((sm) => sm.message as Message);

	const state: TurnState = {
		mentalMapHtml:
			(await ctx.conversationRepo.loadMostRecentMentalMap(
				agentId,
				missionId,
			)) ?? initMentalMap(agent, sharedDir, workdir),
		turnNumber: 0,
		callSeq: -1,
		postedToSupervisor: false,
		lastAssistantText: "",
	};
	const setMentalMap = (html: string) => {
		state.mentalMapHtml = html;
		ctx.onMentalMapUpdate?.(agentId, html);
	};

	const reflectionTriggered =
		sessionMessages.length > 0 &&
		(await shouldReflect({
			peakInputTokens: peakContextTokens(sessionMessages),
			contextWindow: ctx.model.contextWindow || CTX_LIMIT,
			zeroOutputStreak:
				(
					await ctx.statsCollector?.readLifetime(missionId, agentId)
				)?.consecutiveZeroOutputTurns ?? 0,
		}));
	if (reflectionTriggered) {
		await reflectGuarded(ctx, agentId, missionId, async () => {
			history = await reflectSession(ctx, agentId, missionId, {
				sessionMessages,
				nonSummaryHistory,
				history,
				getMentalMap: () => state.mentalMapHtml,
				setMentalMap,
				makeOnLlmCall,
			});
		});
	}

	state.turnNumber =
		history.reduce((max, s) => Math.max(max, s.turnNumber), -1) + 1;
	const synced = await syncObjectivesSection(
		ctx,
		missionId,
		agentId,
		state.turnNumber,
		state.mentalMapHtml,
	);
	if (synced !== null) setMentalMap(synced);

	return {
		state,
		previousMessages: convertToLlm(history),
		reflectionTriggered,
	};
}

/**
 * Peak total context across the session's LLM calls. Must include cacheRead
 * and cacheWrite: with a warm prompt cache (the frequently-running copilot)
 * fresh `input` is about 1 token and the context lives in `cacheRead`, so
 * counting only `input` would keep reflection from ever firing.
 */
function peakContextTokens(sessionMessages: Message[]): number {
	return sessionMessages
		.filter((m): m is AssistantMessage => m.role === "assistant")
		.reduce((max, m) => {
			const u = m.usage as
				| { input?: number; cacheRead?: number; cacheWrite?: number }
				| undefined;
			const total =
				(u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
			return Math.max(max, total);
		}, 0);
}

export interface TurnHooks {
	onMessage: NonNullable<InnerLoopConfig["onMessage"]>;
	onToolResult: InnerLoopConfig["onToolResult"];
	/** The loop's onLlmCall for a given turn: audit log + stats, then a limit check. */
	onLlmCallFor: (turnNumber: number) => OnLlmCall | undefined;
	/** Tool-side LLM calls (vision, OCR, Research) count against the active turn. */
	meter: LlmCallMeter;
}

/**
 * The loop callbacks: persist every message as it arrives (assistant
 * messages with the mental-map snapshot and the call id), feed tool results
 * to the stats collector, and re-check limits after every LLM call and tool
 * result (live config, ADR-0018).
 */
export function createTurnHooks(
	ctx: AgentRunContext,
	agent: AgentConfig,
	missionId: string,
	state: TurnState,
	makeOnLlmCall: MakeOnLlmCall,
): TurnHooks {
	const agentId = agent.id;
	const onMessage: TurnHooks["onMessage"] = async (msg, allMessages, meta) => {
		if (msg.role === "assistant") {
			state.callSeq++;
			const textContent = msg.content.find((b) => b.type === "text");
			if (textContent && "text" in textContent && textContent.text.trim()) {
				state.lastAssistantText = textContent.text.trim();
			}
			await ctx.conversationRepo.append(agentId, missionId, [
				{
					turnNumber: state.turnNumber,
					callSeq: state.callSeq,
					...(meta?.callId ? { callId: meta.callId } : {}),
					mentalMapHtml: state.mentalMapHtml,
					message: msg,
				},
			]);
		} else {
			await ctx.conversationRepo.append(agentId, missionId, [
				{ turnNumber: state.turnNumber, callSeq: state.callSeq, message: msg },
			]);
		}
		await ctx.onMessage?.(msg, allMessages);
	};

	const enforceLimits = createLimitEnforcer(
		ctx,
		agent,
		missionId,
		() => state.turnNumber,
	);
	// Undefined without a stats collector (enforceLimits is only ever wired alongside one).
	const onToolResult: TurnHooks["onToolResult"] = ctx.statsCollector
		? async (event) => {
				await ctx.statsCollector?.recordToolResult(agentId, event);
				await enforceLimits?.();
			}
		: undefined;

	const onLlmCallFor = (turnNumber: number): OnLlmCall | undefined => {
		const base = makeOnLlmCall(turnNumber, false);
		if (!base && !enforceLimits) return undefined;
		return async (event) => {
			if (base) await base(event);
			await enforceLimits?.();
		};
	};
	const meter: LlmCallMeter = async (event) => {
		await onLlmCallFor(state.turnNumber)?.(event);
	};
	return { onMessage, onToolResult, onLlmCallFor, meter };
}

/**
 * The agent's tools for this turn: Tier A (file, mailbox, mental map, web,
 * research, memory, objectives) minus `disabledTools`, then the caller's
 * `additionalTools`, which are never filtered. The BrowseWeb handle is
 * returned so the caller closes its browser session when the turn ends.
 */
export function buildTurnTools(
	ctx: AgentRunContext,
	agent: AgentConfig,
	acl: AclPolicy,
	missionId: string,
	state: TurnState,
	hooks: Pick<TurnHooks, "meter">,
): { tools: MagiTool[]; closeBrowser: () => Promise<void> } {
	const agentId = agent.id;
	const { workdir, sharedDir, linuxUser } = ctx.identity;
	const visionModel = ctx.visionModel ?? ctx.model;
	const supervisorId = agent.supervisor ?? "user";
	const searchWebTool = tryCreateSearchWebTool();
	// One browser session per turn, so every BrowseWeb call in the turn shares
	// cookies, auth and history.
	const browseWebHandle = tryCreateBrowseWebTool(
		visionModel,
		sharedDir,
		ctx.allowedHosts ?? [],
	);
	// Research's Bash sees only sharedDir: it can read artifacts and the
	// research index, never the agent's private workspace.
	const researchAcl: AclPolicy = {
		agentId,
		permittedPaths: [sharedDir],
		linuxUser,
	};
	const appendSubLoop = async (toolUseId: string, msg: Message) => {
		await ctx.conversationRepo.append(agentId, missionId, [
			{
				turnNumber: state.turnNumber,
				callSeq: state.callSeq,
				parentToolUseId: toolUseId,
				message: msg,
			},
		]);
	};

	const tierA = [
		...createFileTools(workdir, acl),
		...createMailboxTools(ctx.mailboxRepo, ctx.teamConfig, agentId, {
			onUserMessage: ctx.onUserMessage,
			onPost: (msg) => {
				if (msg.to.includes(supervisorId)) state.postedToSupervisor = true;
			},
		}),
		...createMentalMapTools(
			() => state.mentalMapHtml,
			(html) => {
				state.mentalMapHtml = html;
				ctx.onMentalMapUpdate?.(agentId, html);
			},
		),
		createFetchUrlTool(visionModel, sharedDir, ctx.allowedHosts ?? [], {
			meter: hooks.meter,
		}),
		createInspectImageTool(workdir, visionModel, [sharedDir], hooks.meter),
		createResearchTool(ctx.model, sharedDir, researchAcl, {
			visionModel,
			onSubLoopMessage: appendSubLoop,
			onSubLoopLlmCall: hooks.meter,
			disabledTools: agent.disabledTools,
		}),
		createAnalyzeMemoriesTool({
			conversationRepo: ctx.conversationRepo,
			agentId,
			missionId,
		}),
		...(searchWebTool ? [searchWebTool] : []),
		...(browseWebHandle ? [browseWebHandle.tool] : []),
		...(ctx.objectivesRepo
			? createObjectivesTools(ctx.objectivesRepo, missionId, agentId)
			: []),
	];
	const disabled = new Set(agent.disabledTools ?? []);
	return {
		tools: [
			...tierA.filter((t) => !disabled.has(t.name)),
			...(ctx.additionalTools ?? []),
		],
		closeBrowser: async () => {
			await browseWebHandle?.close();
		},
	};
}

export interface LoopRun {
	/** The first attempt's messages (the supervisor fallback reads them). */
	messages: Message[];
	/** The first attempt's last call was cut short by the loop's own per-call deadline. */
	lastCallAborted: boolean;
}

/**
 * Run the inner loop. When the very first LLM call fails on the stored
 * history's structure (a tool_use/tool_result mismatch, same-role messages),
 * no tool has run, so the history itself is at fault: force-compact it and
 * retry once with a clean slate.
 */
export async function runWithRecovery(
	ctx: AgentRunContext,
	agentId: string,
	missionId: string,
	state: TurnState,
	loop: Omit<InnerLoopConfig, "previousMessages" | "onLlmCall">,
	previousMessages: Message[],
	onLlmCallFor: TurnHooks["onLlmCallFor"],
): Promise<LoopRun> {
	const result = await runInnerLoop({
		...loop,
		previousMessages,
		onLlmCall: onLlmCallFor(state.turnNumber),
	});
	// The loop's own per-call deadline aborts through a signal derived from
	// (not identical to) the turn's, so `signal.aborted` alone would miss it.
	const lastMsg = result.messages.at(-1);
	const lastCallAborted =
		lastMsg?.role === "assistant" && lastMsg.stopReason === "aborted";

	// The LAST message, not the first assistant one: with real prior history
	// the first is an old success, and the check would never fire.
	// turnCount === 1 guarantees nothing follows the erroring message.
	const latestAssistant = lastMsg?.role === "assistant" ? lastMsg : undefined;
	if (
		result.turnCount === 1 &&
		latestAssistant &&
		isConversationStructureError(latestAssistant) &&
		state.turnNumber > 0
	) {
		console.error(
			`[runAgent] ${agentId}: conversation structure error on first LLM call — ` +
				`force-compacting history and retrying`,
		);
		await forceCompactSession(
			agentId,
			missionId,
			state.turnNumber,
			ctx.conversationRepo,
		);
		const cleanHistory = await ctx.conversationRepo.load(agentId, missionId);
		state.turnNumber =
			cleanHistory.reduce((max, s) => Math.max(max, s.turnNumber), -1) + 1;
		state.callSeq = -1;
		// Same tool set as the first attempt (audit R1).
		await runInnerLoop({
			...loop,
			previousMessages: convertToLlm(cleanHistory),
			onLlmCall: onLlmCallFor(state.turnNumber),
		});
	}
	return { messages: result.messages, lastCallAborted };
}
