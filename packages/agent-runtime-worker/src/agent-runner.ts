import type { TeamConfig } from "@magi/agent-config";
import type { AssistantMessage, Message, Model } from "@mariozechner/pi-ai";
import { createLlmCallHook } from "./agent-runner-llm-log.js";
import {
	finalizeTurn,
	postSupervisorFallback,
	printSessionDebug,
} from "./agent-runner-phases.js";
import {
	buildTurnTools,
	createTurnHooks,
	prepareTurn,
	runWithRecovery,
} from "./agent-runner-turn.js";
import type { StatsCollector } from "./agent-stats.js";
import type { AnomalyRecorder } from "./anomaly.js";
import type {
	ConversationRepository,
	SummaryMessage,
} from "./conversation-repository.js";
import type { LimitAlert, LimitConfig } from "./limits.js";
import { LimitExceededError } from "./limits.js";
import type { LlmCallLogRepository } from "./llm-call-log.js";
import type { MailboxMessage, MailboxRepository } from "./mailbox.js";
import type { MissionConfigRepository } from "./mission-config.js";
import { MISSION_COPILOT_AGENT_ID } from "./mission-copilot.js";
import type { ObjectivesRepository } from "./objectives/repository.js";
import {
	buildDynamicContextMessage,
	buildSystemPrompt,
	formatMessages,
} from "./prompt.js";
import type { AclPolicy, MagiTool } from "./tools.js";
import type { AgentIdentity } from "./workspace-manager.js";

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
	/** Called when a mental_map_* tool changes the agent's mental map. Used for SSE push to the cockpit. */
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
	/**
	 * The mission's spend-cap pause. A running turn (and its Research
	 * sub-loops) waits here before each LLM call while the cap is reached, and
	 * carries on when it is raised.
	 */
	budget?: { isPaused: () => boolean; wait: () => Promise<void> };
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
	const missionId = ctx.teamConfig.mission.id;
	const { workdir, sharedDir } = ctx.identity;

	const makeOnLlmCall = createLlmCallHook(ctx, missionId, agentId);
	const { state, previousMessages, reflectionTriggered } = await prepareTurn(
		ctx,
		agent,
		missionId,
		makeOnLlmCall,
	);
	const hooks = createTurnHooks(
		ctx,
		agent,
		missionId,
		state,
		makeOnLlmCall,
		signal,
	);
	const { tools, closeBrowser } = buildTurnTools(
		ctx,
		agent,
		agentAcl(agentId, ctx.identity),
		missionId,
		state,
		hooks,
	);

	// The system prompt is static per agent and session (cacheable); the mental
	// map and the current time go in the dynamic context, re-read on every
	// call so a mid-turn mental-map edit shows up on the next one.
	const getSystemPrompt = () => buildSystemPrompt(agent, sharedDir, workdir);
	const getDynamicContext = () =>
		buildDynamicContextMessage(
			state.mentalMapHtml,
			ctx.teamConfig.mission.timezone,
		);
	const task = formatMessages(messages);
	if (process.env.DEBUG_SESSIONS === "1") {
		printSessionDebug(
			agentId,
			state.turnNumber,
			getSystemPrompt(),
			getDynamicContext(),
			previousMessages,
		);
	}

	const supervisorId = agent.supervisor ?? "user";
	const supervisorTriggered = messages.some((m) => m.from === supervisorId);
	await ctx.statsCollector?.startTurn(
		missionId,
		agentId,
		state.turnNumber,
		reflectionTriggered,
	);

	// A hard limit is a deliberate stop: the turn finalizes as 'aborted' and
	// nothing is re-thrown. The alert was already routed by the limit check.
	let limitAborted = false;
	let lastCallAborted = false;
	try {
		const run = await runWithRecovery(
			ctx,
			agentId,
			missionId,
			state,
			{
				model: ctx.model,
				getSystemPrompt,
				getDynamicContext,
				task,
				tools,
				signal,
				onMessage: hooks.onMessage,
				onToolResult: hooks.onToolResult,
				beforeLlmCall: hooks.beforeLlmCall,
				reasoning: "medium",
				sessionId: `${missionId}:${agentId}`,
			},
			previousMessages,
			hooks.onLlmCallFor,
		);
		lastCallAborted = run.lastCallAborted;
		if (supervisorTriggered && !state.postedToSupervisor && !signal?.aborted) {
			await postSupervisorFallback(ctx, {
				missionId,
				agentId,
				supervisorId,
				incoming: messages,
				lastAssistantText: state.lastAssistantText,
				loopMessages: run.messages,
			});
		}
	} catch (e) {
		if (!(e instanceof LimitExceededError)) throw e;
		limitAborted = true;
		console.warn(
			`[runAgent] ${agentId}: turn ${state.turnNumber} aborted by hard limit — ${e.message}`,
		);
	} finally {
		await finalizeTurn(ctx, {
			missionId,
			agentId,
			turnNumber: state.turnNumber,
			aborted: limitAborted || signal?.aborted === true || lastCallAborted,
		});
		await closeBrowser();
	}
}

/**
 * The agent's file-tool ACL: its private workdir and the shared folder. Only
 * the mission copilot also reads the bundled platform source and SPEC
 * (/opt/magi-src, ADR-0016) to diagnose platform bugs — never widened for
 * another agent, and the files are read-only on disk too. Tools run as the
 * agent's own OS user via sudo.
 */
function agentAcl(agentId: string, identity: AgentIdentity): AclPolicy {
	const { workdir, sharedDir, linuxUser } = identity;
	const permittedPaths = [workdir, sharedDir];
	if (agentId === MISSION_COPILOT_AGENT_ID)
		permittedPaths.push("/opt/magi-src");
	return { agentId, permittedPaths, linuxUser, sharedDir };
}
