import type { TeamConfig } from "@magi/agent-config";
import type { AssistantMessage, Message, Model } from "@mariozechner/pi-ai";
import { createLlmCallHook } from "./agent-runner-llm-log.js";
import {
	createLimitEnforcer,
	finalizeTurn,
	postSupervisorFallback,
	printSessionDebug,
	syncObjectivesSection,
} from "./agent-runner-phases.js";
import type { StatsCollector } from "./agent-stats.js";
import type { AnomalyRecorder } from "./anomaly.js";
import type {
	ConversationRepository,
	SummaryMessage,
} from "./conversation-repository.js";
import type { LimitAlert, LimitConfig } from "./limits.js";
import { LimitExceededError } from "./limits.js";
import type { LlmCallLogRepository } from "./llm-call-log.js";
import type { LlmCallMeter } from "./llm-meter.js";
import { runInnerLoop } from "./loop.js";
import type { MailboxMessage, MailboxRepository } from "./mailbox.js";
import { createMailboxTools } from "./mailbox.js";
import { createMentalMapTools, initMentalMap } from "./mental-map.js";
import type { MissionConfigRepository } from "./mission-config.js";
import { MISSION_COPILOT_AGENT_ID } from "./mission-copilot.js";
import type { ObjectivesRepository } from "./objectives/repository.js";
import { createObjectivesTools } from "./objectives/tools.js";
import {
	buildDynamicContextMessage,
	buildSystemPrompt,
	formatMessages,
} from "./prompt.js";
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
import type { AgentIdentity } from "./workspace-manager.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Input token limit for Claude Sonnet 4.6. */
const CTX_LIMIT = 200_000;

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
	/**
	 * Optional per-turn / mission statistics collector. When present, the agent
	 * loop feeds it each LLM call and tool result and brackets the turn with
	 * startTurn/endTurn. Shared across agents; keyed internally by agentId.
	 */
	statsCollector?: StatsCollector;
	/**
	 * Optional live config reader (ADR-0018). When present, `enforceLimits`
	 * reads the agent's current `limits` fresh from MongoDB on every check
	 * instead of the boot-time `teamConfig` snapshot, so a cockpit edit takes
	 * effect immediately with no suspend/resume. Falls back to the snapshot
	 * when absent or when a live read fails.
	 */
	missionConfig?: MissionConfigRepository;
	/**
	 * Optional Mongo-backed objectives store (ADR-0019). When present, the
	 * agent gets the AddTask/UpdateTask/RecordKpi/Allocate tools, the
	 * #my-objectives mental-map sync runs each turn, and turn-end cost
	 * attribution writes into it. Absent in test/CLI harnesses that don't
	 * exercise objectives — all three of those steps simply no-op.
	 */
	objectivesRepo?: ObjectivesRepository;
	/**
	 * Called when a configured limit (see agent `limits`) is breached — soft
	 * limits fire an advisory alert (deduped per rule per turn); a hard limit
	 * fires an alert and then aborts the turn. The daemon routes these to the
	 * copilot mailbox and the monitor dashboard. Requires `statsCollector`.
	 */
	onLimitAlert?: (alert: LimitAlert) => void;
	/** Records soft/hard anomalies (reflection failures here); absent in the CLI and in tests. */
	anomalyRecorder?: Pick<AnomalyRecorder, "record">;
	/**
	 * Commit the shared workspace at turn end (git-commit-on-sleep, Sprint 25).
	 * Returns the commit SHA + changed files, or null when nothing changed.
	 * Serialized across concurrent agents by the caller. The result is recorded
	 * on the turn stats (`gitCommit`/`gitChangedFiles`).
	 */
	commitWorkspace?: (message: string) => Promise<{
		commit: string;
		changedFiles: { path: string; status: string }[];
	} | null>;
	/** Per-agent workspace identity providing private workdir and ACL. */
	identity: AgentIdentity;
	/** Called immediately when the agent posts a message to "user". */
	onUserMessage?: (msg: MailboxMessage) => void;
	/** Called for every message produced by the inner loop (for logging/streaming). */
	onMessage?: (msg: Message, allMessages: Message[]) => Promise<void>;
	/** Called when UpdateMentalMap changes the agent's mental map. Used for SSE push to dashboard. */
	onMentalMapUpdate?: (agentId: string, html: string) => void;
	/**
	 * Extra tools appended after the standard Tier-A tool list.
	 * Intended for caller-provided tools that require infrastructure not available
	 * inside agent-runner (e.g. the copilot's elevated MongoDB/Fly tools).
	 * These are never filtered by agent.disabledTools.
	 */
	additionalTools?: MagiTool[];
	/**
	 * Hosts exempt from the SSRF guard for FetchUrl/BrowseWeb — TEST
	 * INFRASTRUCTURE ONLY (so an integration test can reach its local fixture
	 * server). Never set by the daemon/CLI → SSRF stays fully enforced in prod.
	 */
	allowedHosts?: string[];
}

// ---------------------------------------------------------------------------
// Limit enforcement helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the `LimitConfig` to enforce for `agentId` from a freshly-read
 * TeamConfig (ADR-0018). Falls back to the boot-time snapshot ONLY when the
 * live config itself couldn't be read (`live` is null — missing doc, parse
 * failure, or the caller never attempted the read). When `live` IS available,
 * an agent with no limits configured there is treated as genuinely having
 * none — never silently falling back to a possibly-stale boot-time value,
 * since that would defeat the entire point of reading fresh: an operator
 * clearing a limit must see that take effect immediately, same as setting one.
 *
 * The mission copilot's limits live in `missionCopilotLimits`, a separate
 * top-level TeamConfig field, not `agents[]` — it has no authored node in the
 * persisted config to hang a `limits` key off (see mission-copilot.ts's
 * `injectMissionCopilot`, which only appends it to the in-memory boot-time
 * snapshot, never to what's persisted). A live read must check this field
 * specifically for the copilot, or its own limit edits would silently never
 * apply without a resume — exactly the bug ADR-0018 was fixing for everyone
 * else.
 */
export function resolveLiveLimits(
	live: TeamConfig | null,
	agentId: string,
	bootTimeSnapshot: LimitConfig,
): LimitConfig {
	if (!live) return bootTimeSnapshot;
	if (agentId === MISSION_COPILOT_AGENT_ID) {
		return live.missionCopilotLimits ?? {};
	}
	return live.agents.find((a) => a.id === agentId)?.limits ?? {};
}

// ---------------------------------------------------------------------------
// Conversation recovery helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when an AssistantMessage represents an Anthropic 400
 * invalid conversation structure error — a mismatched tool_use/tool_result
 * sequence, consecutive same-role messages, or other history structure
 * violations. Recognisable patterns:
 *   "messages.N.content.M: unexpected `tool_use_id`…"   (tool pairing error)
 *   "messages: roles must alternate…"                    (consecutive user msgs)
 *   "first message must use the `user` role"             (history ordering)
 */
export function isConversationStructureError(msg: AssistantMessage): boolean {
	if (msg.stopReason !== "error") return false;
	const err = (msg.errorMessage ?? "").toLowerCase();
	return (
		// Tool use/result pairing mismatch
		(err.includes("messages.") &&
			(err.includes("tool_use") || err.includes("tool_result"))) ||
		// Consecutive same-role messages (e.g. two "user" turns in a row)
		err.includes("roles must alternate") ||
		err.includes("first message must use") ||
		err.includes("unexpected role")
	);
}

/**
 * Recover from a conversation history that cannot be replayed.
 *
 * Inserts a recovery summary (crash-safe: written before the destructive
 * compact step), then compacts all messages up to and including the current
 * session's failed messages. The next load() returns only the recovery
 * summary, letting the agent resume from its last known mental map state.
 */
export async function forceCompactSession(
	agentId: string,
	missionId: string,
	nextTurnNumber: number,
	repo: ConversationRepository,
): Promise<void> {
	// The summary must land AT the compact boundary (nextTurnNumber + 1), not
	// before it (nextTurnNumber - 1, the original bug here) — compact()'s
	// `turnNumber < keepFrom` cutoff would otherwise mark the summary itself
	// compacted the instant it's written, since nextTurnNumber - 1 is always
	// < nextTurnNumber + 1. That silently defeated this function's own stated
	// purpose ("next load() returns only the recovery summary") — load()
	// would instead return nothing at all. Found live: this bug was masked
	// until the .findLast fix above made this function actually get called.
	const summaryTurnNumber = nextTurnNumber + 1;
	await repo.append(agentId, missionId, [
		{
			turnNumber: summaryTurnNumber,
			message: {
				role: "summary",
				content:
					"Previous session could not be replayed: the stored conversation " +
					"history contained an invalid message sequence (mismatched " +
					"tool_use/tool_result pairing or consecutive same-role messages). " +
					"The session was discarded. Resuming from the last known mental map state.",
			} as SummaryMessage,
		},
	]);
	// Compact everything strictly before the summary — including the current
	// session's failed messages — so the retry starts with only the recovery
	// summary in context.
	await repo.compact(agentId, missionId, summaryTurnNumber);
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
	// ADR-0016: only the mission copilot gets read access to the bundled
	// platform source + MAGI_V3_SPEC.md (see the execution-plane Dockerfile),
	// for diagnosing platform bugs and checking the real tool/skill catalog
	// before granting one — never widened for any other agent. The files
	// themselves are also filesystem-read-only (owned by a different user),
	// so this is defense in depth, not the only thing stopping a write.
	if (agentId === MISSION_COPILOT_AGENT_ID) {
		permittedPaths.push("/opt/magi-src");
	}

	// linuxUser comes from ctx.identity — the authoritative source provisioned by
	// WorkspaceManager. Tool execution always runs as this OS user via sudo.
	const acl: AclPolicy = {
		agentId,
		permittedPaths,
		linuxUser,
		sharedDir,
	};

	const missionId = ctx.teamConfig.mission.id;

	// Load conversation history from previous wakeups.
	let history = await loadRepairedHistory(
		ctx.conversationRepo,
		agentId,
		missionId,
	);

	// Reflect on the previous session before starting this one (skip on first wakeup).
	// sessionMessages are the full raw messages from the previous session — no
	// content is collapsed here; compaction applies only via the repository's
	// compact() call inside runReflection, which marks old docs as compacted so
	// they are excluded from future load() calls.
	const nonSummaryHistory = history.filter(
		(sm) => sm.message.role !== "summary",
	);
	const sessionMessages = nonSummaryHistory.map((sm) => sm.message as Message);

	// Peak total context tokens across all LLM calls in the previous session.
	// Must include cacheRead and cacheWrite alongside fresh input tokens — when
	// the Anthropic prompt cache is warm (as it is for the frequently-running
	// copilot), fresh `input` is ≈ 1 token while the full context lives in
	// `cacheRead`. Counting only `input` prevents reflection from ever firing.
	const peakInputTokens = sessionMessages
		.filter((m): m is AssistantMessage => m.role === "assistant")
		.reduce((max, m) => {
			const u = m.usage as
				| { input?: number; cacheRead?: number; cacheWrite?: number }
				| undefined;
			const total =
				(u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
			return Math.max(max, total);
		}, 0);

	/**
	 * Build the onLlmCall handler for a given turnNumber and isReflection flag.
	 * Writes one entry to llmCallLog per LLM response (if configured) and feeds
	 * the statistics collector (if configured). Returns undefined when neither is
	 * configured so the loop skips the hook entirely.
	 *
	 * Reflection calls are excluded from the turn collector: reflection runs
	 * before startTurn (no active turn accumulator exists yet) and is surfaced via
	 * the turn's reflectionTriggered flag instead.
	 */
	const makeOnLlmCall = createLlmCallHook(ctx, missionId, agentId);

	// Load mental map from the most recent AssistantMessage snapshot in conversationMessages.
	// Falls back to initMentalMap if this is the first wakeup.
	let currentMentalMapHtml: string =
		(await ctx.conversationRepo.loadMostRecentMentalMap(agentId, missionId)) ??
		initMentalMap(agent, sharedDir, workdir);

	const reflectionTriggered =
		sessionMessages.length > 0 &&
		(await shouldReflect({
			peakInputTokens,
			contextWindow: ctx.model.contextWindow || CTX_LIMIT,
			zeroOutputStreak:
				(
					await ctx.statsCollector?.readLifetime(missionId, agentId)
				)?.consecutiveZeroOutputTurns ?? 0,
		}));
	if (reflectionTriggered) {
		await reflectGuarded(ctx, agentId, missionId, runReflectionStep);
	}
	async function runReflectionStep(): Promise<void> {
		history = await reflectSession(ctx, agentId, missionId, {
			sessionMessages,
			nonSummaryHistory,
			history,
			getMentalMap: () => currentMentalMapHtml,
			setMentalMap: (html) => {
				currentMentalMapHtml = html;
				ctx.onMentalMapUpdate?.(agentId, html);
			},
			makeOnLlmCall,
		});
	}

	let activeTurnNumber =
		history.reduce((max, s) => Math.max(max, s.turnNumber), -1) + 1;

	const synced = await syncObjectivesSection(
		ctx,
		missionId,
		agentId,
		activeTurnNumber,
		currentMentalMapHtml,
	);
	if (synced !== null) {
		currentMentalMapHtml = synced;
		ctx.onMentalMapUpdate?.(agentId, currentMentalMapHtml);
	}

	const previousMessages = convertToLlm(history);

	// Track which LLM call within this session we're on.
	// -1 = task user message (before first LLM call); increments to 0, 1, 2… on each AssistantMessage.
	let currentCallSeq = -1;

	// The system prompt is now fully static per agent/session (see prompt.ts) —
	// this getter exists for InnerLoopConfig's interface, not because the output
	// actually varies call to call. The mental map + current time live in
	// getDynamicContext below instead.
	const getSystemPrompt = () => buildSystemPrompt(agent, sharedDir, workdir);

	// Getter so the inner loop picks up mid-turn UpdateMentalMap changes and
	// refreshes the current-time block on the very next call, without touching
	// the (now-static, cacheable) system prompt — see prompt.ts and loop.ts's
	// runInnerLoop for how this is spliced into messages[0].
	const getDynamicContext = () =>
		buildDynamicContextMessage(
			currentMentalMapHtml,
			ctx.teamConfig.mission.timezone,
		);

	const task = formatMessages(messages);

	if (process.env.DEBUG_SESSIONS === "1") {
		printSessionDebug(
			agentId,
			activeTurnNumber,
			getSystemPrompt(),
			getDynamicContext(),
			previousMessages,
		);
	}

	const visionModel = ctx.visionModel ?? ctx.model;

	const searchWebTool = tryCreateSearchWebTool();
	// BrowseWebHandle is created here (once per agent turn) so all execute() calls
	// within the same runInnerLoop share one browser session (cookies, auth, history).
	const browseWebHandle = tryCreateBrowseWebTool(
		visionModel,
		sharedDir,
		ctx.allowedHosts ?? [],
	);

	// Research sub-loop Bash is restricted to sharedDir only (no workdir).
	// This lets it read existing artifacts and the research index without
	// touching the agent's private workspace or running git/write operations.
	const researchAcl: AclPolicy = {
		agentId,
		permittedPaths: [sharedDir],
		linuxUser,
	};

	const appendSubLoop = async (toolUseId: string, msg: Message) => {
		await ctx.conversationRepo.append(agentId, missionId, [
			{
				turnNumber: activeTurnNumber,
				callSeq: currentCallSeq,
				parentToolUseId: toolUseId,
				message: msg,
			},
		]);
	};

	// Track whether the agent posted to its supervisor this turn.
	const supervisorId = agent.supervisor ?? "user";
	let postedToSupervisor = false;
	let lastAssistantText = "";

	// Tool-side LLM calls (vision, OCR, Research) count against the active turn.
	const meter: LlmCallMeter = async (event) => {
		await makeOnLlmCallWithLimits(activeTurnNumber)?.(event);
	};

	const tools = [
		...createFileTools(workdir, acl),
		...createMailboxTools(ctx.mailboxRepo, ctx.teamConfig, agentId, {
			onUserMessage: ctx.onUserMessage,
			onPost: (msg) => {
				if (msg.to.includes(supervisorId)) postedToSupervisor = true;
			},
		}),
		...createMentalMapTools(
			() => currentMentalMapHtml,
			(html) => {
				currentMentalMapHtml = html;
				ctx.onMentalMapUpdate?.(agentId, html);
			},
		),
		createFetchUrlTool(visionModel, sharedDir, ctx.allowedHosts ?? [], {
			meter,
		}),
		createInspectImageTool(workdir, visionModel, [sharedDir], meter),
		createResearchTool(ctx.model, sharedDir, researchAcl, {
			visionModel,
			onSubLoopMessage: appendSubLoop,
			onSubLoopLlmCall: meter,
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

	// Apply disabledTools filter (Tier A only), then append additionalTools (Tier B, never filtered).
	const disabledToolNames = new Set(agent.disabledTools ?? []);
	const effectiveTools =
		disabledToolNames.size > 0
			? [
					...tools.filter((t) => !disabledToolNames.has(t.name)),
					...(ctx.additionalTools ?? []),
				]
			: [...tools, ...(ctx.additionalTools ?? [])];

	// Persist each message immediately as it arrives. Uses activeTurnNumber via
	// closure so the retry can update the turn without rebuilding the handler.
	const onMessageHandler = async (
		msg: Message,
		allMessages: Message[],
		meta?: { callId?: string },
	) => {
		if (msg.role === "assistant") {
			currentCallSeq++;
			// Capture the last plain-text reply for use in the auto-post fallback.
			const textContent = msg.content.find((b) => b.type === "text");
			if (textContent && "text" in textContent && textContent.text.trim()) {
				lastAssistantText = textContent.text.trim();
			}
			const snapshotHtml = currentMentalMapHtml;
			await ctx.conversationRepo.append(agentId, missionId, [
				{
					turnNumber: activeTurnNumber,
					callSeq: currentCallSeq,
					...(meta?.callId ? { callId: meta.callId } : {}),
					mentalMapHtml: snapshotHtml,
					message: msg,
				},
			]);
		} else {
			await ctx.conversationRepo.append(agentId, missionId, [
				{
					turnNumber: activeTurnNumber,
					callSeq: currentCallSeq,
					message: msg,
				},
			]);
		}
		await ctx.onMessage?.(msg, allMessages);
	};

	// True when at least one incoming message originated from the supervisor.
	// Used to decide whether the auto-post safety net should fire.
	const supervisorTriggered = messages.some((m) => m.from === supervisorId);

	const enforceLimits = createLimitEnforcer(
		ctx,
		agent,
		missionId,
		() => activeTurnNumber,
	);

	// Feed tool usage to the statistics collector (tool counts, errors, touched
	// files, sent messages, visited URLs), then re-check limits. Undefined
	// without a stats collector (enforceLimits is only ever wired alongside one).
	const onToolResultHandler = ctx.statsCollector
		? async (event: {
				toolName: string;
				args: Record<string, unknown>;
				isError: boolean;
			}) => {
				await ctx.statsCollector?.recordToolResult(agentId, event);
				await enforceLimits?.();
			}
		: undefined;

	// Compose the onLlmCall hook for a turn: audit log + stats (makeOnLlmCall)
	// followed by a limit re-check. enforceLimits reads activeTurnNumber live so
	// the conversation-recovery retry path reports the correct turn.
	const makeOnLlmCallWithLimits = (turnNumber: number) => {
		const base = makeOnLlmCall(turnNumber, false);
		if (!base && !enforceLimits) return undefined;
		return async (event: {
			systemPrompt: string;
			messages: Message[];
			toolNames: string[];
			response: AssistantMessage;
		}) => {
			if (base) await base(event);
			await enforceLimits?.();
		};
	};

	// Bracket the turn for the statistics collector. startTurn resets the in-memory
	// accumulator and (on the first turn after a restart) reloads lifetime totals;
	// endTurn finalizes the turn doc and increments missionStats exactly once.
	await ctx.statsCollector?.startTurn(
		missionId,
		agentId,
		activeTurnNumber,
		reflectionTriggered,
	);

	// Set when a hard limit aborts the turn — distinguishes a deliberate limit
	// stop (recorded as 'aborted', not re-thrown as a crash) from a real error.
	let limitAborted = false;
	// Set when the loop's last LLM call was cut short by runInnerLoop's own
	// per-call deadline (loop.ts's llmCallTimeoutMs) rather than this turn's
	// outer `signal` — that call used a signal DERIVED from (not identical to)
	// `signal`, so `signal?.aborted` alone would miss it and the turn would be
	// finalized as 'complete' even though it was forcibly cut off mid-call.
	let lastCallAborted = false;

	try {
		const result = await runInnerLoop({
			model: ctx.model,
			getSystemPrompt,
			getDynamicContext,
			task,
			tools: effectiveTools,
			signal,
			previousMessages,
			onMessage: onMessageHandler,
			onLlmCall: makeOnLlmCallWithLimits(activeTurnNumber),
			onToolResult: onToolResultHandler,
			reasoning: "medium",
			sessionId: `${missionId}:${agentId}`,
		});
		const lastMsg = result.messages.at(-1);
		lastCallAborted =
			lastMsg?.role === "assistant" && lastMsg.stopReason === "aborted";

		// Detect a conversation structure error on the very first LLM call.
		// turnCount === 1 means no tools ran — the error came from the history,
		// not from anything this session did. Force-compact the corrupt history
		// and retry once with a clean slate.
		//
		// Reuses lastMsg (the LAST message overall), not the FIRST assistant
		// message in result.messages ([...previousMessages, task, ...this
		// session's new messages]). For any agent with real prior history,
		// searching from the front would find the FIRST assistant message ever
		// sent — almost certainly a successful one from long ago — making this
		// check silently never fire. Found live: a corrupted copilot history
		// kept failing identically across multiple retries because this looked
		// at the wrong message. turnCount === 1 guarantees nothing could follow
		// the erroring message, so it's always the last one in the array.
		const latestAssistant = lastMsg?.role === "assistant" ? lastMsg : undefined;
		if (
			result.turnCount === 1 &&
			latestAssistant &&
			isConversationStructureError(latestAssistant) &&
			activeTurnNumber > 0
		) {
			console.error(
				`[runAgent] ${agentId}: conversation structure error on first LLM call — ` +
					`force-compacting history and retrying`,
			);
			await forceCompactSession(
				agentId,
				missionId,
				activeTurnNumber,
				ctx.conversationRepo,
			);
			const cleanHistory = await ctx.conversationRepo.load(agentId, missionId);
			activeTurnNumber =
				cleanHistory.reduce((max, s) => Math.max(max, s.turnNumber), -1) + 1;
			currentCallSeq = -1;
			await runInnerLoop({
				model: ctx.model,
				getSystemPrompt,
				getDynamicContext,
				task,
				// Same set as the first attempt — the unfiltered list re-enabled
				// disabledTools and dropped Tier B tools on retry (audit R1).
				tools: effectiveTools,
				signal,
				previousMessages: convertToLlm(cleanHistory),
				onMessage: onMessageHandler,
				onLlmCall: makeOnLlmCallWithLimits(activeTurnNumber),
				onToolResult: onToolResultHandler,
				reasoning: "medium",
				sessionId: `${missionId}:${agentId}`,
			});
		}

		if (supervisorTriggered && !postedToSupervisor && !signal?.aborted) {
			await postSupervisorFallback(ctx, {
				missionId,
				agentId,
				supervisorId,
				incoming: messages,
				lastAssistantText,
				loopMessages: result.messages,
			});
		}
	} catch (e) {
		// A hard-limit breach is a deliberate stop, not a crash: log and let the
		// turn finalize as 'aborted'. The alert was already routed by enforceLimits.
		// Any other error propagates to the orchestrator's crash handler.
		if (e instanceof LimitExceededError) {
			limitAborted = true;
			console.warn(
				`[runAgent] ${agentId}: turn ${activeTurnNumber} aborted by hard limit — ${e.message}`,
			);
		} else {
			throw e;
		}
	} finally {
		await finalizeTurn(ctx, {
			missionId,
			agentId,
			turnNumber: activeTurnNumber,
			aborted: limitAborted || signal?.aborted === true || lastCallAborted,
		});
		// Close the browser session regardless of success or failure.
		await browseWebHandle?.close();
	}
}
