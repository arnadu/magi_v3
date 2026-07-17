import type { TeamConfig } from "@magi/agent-config";
import type { AssistantMessage, Message, Model } from "@mariozechner/pi-ai";
import type { StatsCollector } from "./agent-stats.js";
import type {
	ConversationRepository,
	SummaryMessage,
} from "./conversation-repository.js";
import type { LimitAlert } from "./limits.js";
import { buildRules, evaluateLimits, LimitExceededError } from "./limits.js";
import type { LlmCallLogRepository } from "./llm-call-log.js";
import { computeCost, truncateToolBodies } from "./llm-call-log.js";
import { runInnerLoop } from "./loop.js";
import type { MailboxMessage, MailboxRepository } from "./mailbox.js";
import { createMailboxTools } from "./mailbox.js";
import {
	createMentalMapTools,
	initMentalMap,
	upsertManagedRegion,
} from "./mental-map.js";
import { MISSION_COPILOT_AGENT_ID } from "./mission-copilot.js";
import {
	MY_OBJECTIVES_KEY,
	renderMyObjectives,
} from "./objectives/agent-view.js";
import {
	attributeTurnCost,
	STALE_TURNS,
	turnsSinceLastAttribution,
} from "./objectives/attribution.js";
import { loadCostEvents, loadObjectivesStore } from "./objectives/store.js";
import { buildSystemPrompt, formatMessages } from "./prompt.js";
import { convertToLlm, runReflection } from "./reflection.js";
import {
	readSupervisorNote,
	renderSupervisorNote,
	SUPERVISOR_NOTE_KEY,
} from "./supervisor-note.js";
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
	/**
	 * Optional per-turn / mission statistics collector. When present, the agent
	 * loop feeds it each LLM call and tool result and brackets the turn with
	 * startTurn/endTurn. Shared across agents; keyed internally by agentId.
	 */
	statsCollector?: StatsCollector;
	/**
	 * Called when a configured limit (see agent `limits`) is breached — soft
	 * limits fire an advisory alert (deduped per rule per turn); a hard limit
	 * fires an alert and then aborts the turn. The daemon routes these to the
	 * copilot mailbox and the monitor dashboard. Requires `statsCollector`.
	 */
	onLimitAlert?: (alert: LimitAlert) => void;
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
function isConversationStructureError(msg: AssistantMessage): boolean {
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
async function forceCompactSession(
	agentId: string,
	missionId: string,
	nextTurnNumber: number,
	repo: ConversationRepository,
): Promise<void> {
	await repo.append(agentId, missionId, [
		{
			turnNumber: nextTurnNumber - 1,
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
	// Compact everything including the current session's failed messages so the
	// retry starts with only the recovery summary in context.
	await repo.compact(agentId, missionId, nextTurnNumber + 1);
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
	let history = await ctx.conversationRepo.load(agentId, missionId);

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
	const makeOnLlmCall = (turnNumber: number, isReflection: boolean) => {
		if (!ctx.llmCallLog && !ctx.statsCollector) return undefined;
		return async (event: {
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
			const cost = computeCost(usage, modelCost);
			if (ctx.llmCallLog) {
				await ctx.llmCallLog.append({
					missionId,
					agentId,
					turnNumber,
					isReflection,
					savedAt: new Date(),
					model: ctx.model.id,
					// Anthropic list prices are exact; other providers (OpenRouter) are
					// estimated from list pricing (see issue #10).
					costEstimated: ctx.model.provider !== "anthropic",
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
						cost,
					},
				});
			}
			if (ctx.statsCollector && !isReflection) {
				await ctx.statsCollector.recordLlmCall(agentId, {
					inputTokens: usage.input,
					outputTokens: usage.output,
					cacheReadTokens: usage.cacheRead,
					cacheWriteTokens: usage.cacheWrite,
					costUsd: cost.totalCostUsd,
				});
			}
		};
	};

	// Load mental map from the most recent AssistantMessage snapshot in conversationMessages.
	// Falls back to initMentalMap if this is the first wakeup.
	let currentMentalMapHtml: string =
		(await ctx.conversationRepo.loadMostRecentMentalMap(agentId, missionId)) ??
		initMentalMap(agent, sharedDir, workdir);

	// Read threshold lazily so REFLECTION_THRESHOLD env var set by tests is honoured.
	const reflectionThreshold = process.env.REFLECTION_THRESHOLD
		? Number.parseInt(process.env.REFLECTION_THRESHOLD, 10)
		: REFLECTION_CTX_THRESHOLD;
	const reflectionTriggered =
		sessionMessages.length > 0 && peakInputTokens >= reflectionThreshold;
	if (reflectionTriggered) {
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
			onMessage: ctx.onMessage ? (msg) => ctx.onMessage?.(msg, []) : undefined,
			onLlmCall: makeOnLlmCall(lastTurnNumber + 1, true),
		});
		// Reload: compacted docs are now excluded and the new summary is visible.
		history = await ctx.conversationRepo.load(agentId, missionId);
	}

	let activeTurnNumber =
		history.reduce((max, s) => Math.max(max, s.turnNumber), -1) + 1;

	// Sync the daemon-managed #my-objectives mental-map section from the
	// objectives store (Sprint 26a, B1). The agent reads its owned tasks/KPIs
	// here and acts via the objectives skill scripts. The staleness nudge (B2b)
	// is shown when the agent has cost unattributed for several turns. Store
	// load must never break the turn — on any error, leave the mental map alone.
	try {
		const tree = await loadObjectivesStore(sharedDir);
		const costEvents = await loadCostEvents(sharedDir);
		const staleAttributionTurns = turnsSinceLastAttribution(
			costEvents,
			agentId,
			activeTurnNumber,
		);
		const section = renderMyObjectives(tree, agentId, {
			staleAttributionTurns,
			staleThreshold: STALE_TURNS,
		});
		if (section !== null) {
			currentMentalMapHtml = upsertManagedRegion(
				currentMentalMapHtml,
				MY_OBJECTIVES_KEY,
				section,
			);
			ctx.onMentalMapUpdate?.(agentId, currentMentalMapHtml);
		}
	} catch (e) {
		console.error("[agent-runner] objectives sync failed", {
			missionId,
			agentId,
			error: (e as Error).message,
		});
	}

	// Sync the daemon-managed #supervisor-note mental-map section (ADR-0016) —
	// the same lazy-render-at-turn-start pattern as #my-objectives above.
	// Written by the mission copilot's EditAgentMentalMap tool; read fresh
	// every turn rather than pushed, so there's no out-of-band write into this
	// agent's own conversation history to get wrong.
	try {
		const entry = await readSupervisorNote(sharedDir, agentId);
		if (entry !== null) {
			currentMentalMapHtml = upsertManagedRegion(
				currentMentalMapHtml,
				SUPERVISOR_NOTE_KEY,
				renderSupervisorNote(entry),
			);
			ctx.onMentalMapUpdate?.(agentId, currentMentalMapHtml);
		}
	} catch (e) {
		console.error("[agent-runner] supervisor-note sync failed", {
			missionId,
			agentId,
			error: (e as Error).message,
		});
	}

	const previousMessages = convertToLlm(history);

	// Track which LLM call within this session we're on.
	// -1 = task user message (before first LLM call); increments to 0, 1, 2… on each AssistantMessage.
	let currentCallSeq = -1;

	// Getter so the inner loop rebuilds the system prompt each iteration (picks up
	// UpdateMentalMap changes and refreshes the current-time block — see prompt.ts).
	const getSystemPrompt = () =>
		buildSystemPrompt(
			agent,
			currentMentalMapHtml,
			sharedDir,
			workdir,
			ctx.teamConfig.mission.timezone,
		);

	const task = formatMessages(messages);

	// Debug: print context passed to the LLM at session start.
	// Enable with DEBUG_SESSIONS=1 in the environment.
	if (process.env.DEBUG_SESSIONS === "1") {
		const sep = "═".repeat(72);
		console.log(`\n${sep}`);
		console.log(`[DEBUG] Agent: ${agentId}  Turn: ${activeTurnNumber}`);
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
				console.log(
					`  [${m.role}] ${preview}${preview.length >= 500 ? "…" : ""}`,
				);
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
		createFetchUrlTool(visionModel, sharedDir, ctx.allowedHosts ?? []),
		createInspectImageTool(workdir, visionModel, [sharedDir]),
		createResearchTool(ctx.model, sharedDir, researchAcl, {
			visionModel,
			onSubLoopMessage: appendSubLoop,
		}),
		createAnalyzeMemoriesTool({
			conversationRepo: ctx.conversationRepo,
			agentId,
			missionId,
		}),
		...(searchWebTool ? [searchWebTool] : []),
		...(browseWebHandle ? [browseWebHandle.tool] : []),
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
	const onMessageHandler = async (msg: Message, allMessages: Message[]) => {
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

	// Limit enforcement (Sprint 24). Rules are built from the agent's `limits`
	// config layered over conservative soft defaults; enforcement is a no-op
	// without a stats collector (the rules read its in-memory accumulators).
	const limitRules = ctx.statsCollector ? buildRules(agent.limits) : [];
	// Soft alerts are fired at most once per rule per turn.
	const firedSoftLimits = new Set<string>();
	const enforceLimits =
		ctx.statsCollector && limitRules.length > 0
			? () => {
					const turn = ctx.statsCollector?.getTurn(agentId);
					if (!turn) return;
					const lifetime = ctx.statsCollector?.getLifetime(agentId);
					const breaches = evaluateLimits(turn, lifetime, limitRules);
					for (const b of breaches) {
						if (b.rule.severity === "soft" && !firedSoftLimits.has(b.rule.id)) {
							firedSoftLimits.add(b.rule.id);
							ctx.onLimitAlert?.({
								agentId,
								turnNumber: activeTurnNumber,
								breach: b,
							});
						}
					}
					// A hard breach aborts the turn: alert first, then throw so the inner
					// loop stops before the next LLM call / tool round.
					const hard = breaches.find((b) => b.rule.severity === "hard");
					if (hard) {
						ctx.onLimitAlert?.({
							agentId,
							turnNumber: activeTurnNumber,
							breach: hard,
						});
						throw new LimitExceededError(hard);
					}
				}
			: undefined;

	// Feed tool usage to the statistics collector (tool counts, errors, touched
	// files, sent messages, visited URLs), then re-check limits. Undefined when
	// neither a collector nor enforcement is wired.
	const onToolResultHandler =
		ctx.statsCollector || enforceLimits
			? async (event: {
					toolName: string;
					args: Record<string, unknown>;
					isError: boolean;
				}) => {
					await ctx.statsCollector?.recordToolResult(agentId, event);
					enforceLimits?.();
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
			enforceLimits?.();
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
			task,
			tools: effectiveTools,
			signal,
			previousMessages,
			onMessage: onMessageHandler,
			onLlmCall: makeOnLlmCallWithLimits(activeTurnNumber),
			onToolResult: onToolResultHandler,
			reasoning: "medium",
		});
		const lastMsg = result.messages.at(-1);
		lastCallAborted =
			lastMsg?.role === "assistant" && lastMsg.stopReason === "aborted";

		// Detect a conversation structure error on the very first LLM call.
		// turnCount === 1 means no tools ran — the error came from the history,
		// not from anything this session did. Force-compact the corrupt history
		// and retry once with a clean slate.
		const firstAssistant = result.messages.find(
			(m): m is AssistantMessage => m.role === "assistant",
		);
		if (
			result.turnCount === 1 &&
			firstAssistant &&
			isConversationStructureError(firstAssistant) &&
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
				task,
				tools,
				signal,
				previousMessages: convertToLlm(cleanHistory),
				onMessage: onMessageHandler,
				onLlmCall: makeOnLlmCallWithLimits(activeTurnNumber),
				onToolResult: onToolResultHandler,
				reasoning: "medium",
			});
		}

		// Safety net: if the supervisor triggered this run but the agent never
		// posted back to them, auto-post a brief status message so the operator
		// always sees an acknowledgment.
		if (supervisorTriggered && !postedToSupervisor && !signal?.aborted) {
			// Prefer the last LLM text response. If that's empty (e.g. the very
			// first LLM call errored out), surface the error message instead of
			// the misleading "Task completed." placeholder.
			const loopError = result.messages
				.filter((m): m is AssistantMessage => m.role === "assistant")
				.map((m) => m.errorMessage)
				.find((e) => !!e);
			const fallbackBody =
				lastAssistantText ||
				(loopError
					? `I encountered an error and could not complete the task.\n\nError: ${loopError}`
					: "Task completed.");
			const incomingSubject = messages[0]?.subject ?? "";
			const autoSubject = incomingSubject
				? `Re: ${incomingSubject}`
				: "Re: (no subject)";
			console.warn(
				`[runAgent] ${agentId}: no PostMessage to supervisor "${supervisorId}" — sending auto-reply`,
			);
			const autoReply = await ctx.mailboxRepo.post({
				missionId,
				from: agentId,
				to: [supervisorId],
				subject: autoSubject,
				body: fallbackBody,
			});
			// Fire the callback so SSE-based frontends (copilot chat) receive the
			// auto-reply immediately. Without this the message lands in MongoDB but
			// is never pushed to the browser.
			if (supervisorId === "user") {
				ctx.onUserMessage?.(autoReply);
			}
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
		// Checkpoint the shared workspace (git-commit-on-sleep). Captures files
		// written by any tool, including Bash/skills. Runs regardless of outcome
		// so an aborted turn's partial work is still preserved. Best-effort.
		const git =
			(await ctx.commitWorkspace?.(`turn: ${agentId}/${activeTurnNumber}`)) ??
			undefined;
		// Capture the turn window before endTurn() drops the accumulator (B2).
		const turnSnapshot = ctx.statsCollector?.getTurn(agentId);
		// Finalize turn statistics regardless of success, error, or abort. An
		// aborted run still incurred cost, so its lifetime totals must be recorded.
		await ctx.statsCollector?.endTurn(
			agentId,
			limitAborted || signal?.aborted || lastCallAborted
				? "aborted"
				: "complete",
			git ?? undefined,
		);
		// Attribute the turn's cost to the task(s) the agent updated this turn
		// (Sprint 26a, B2). Runs after endTurn so lifetimeCostUsd includes this
		// turn. Best-effort: a failure here must never break the turn.
		if (ctx.statsCollector && turnSnapshot) {
			try {
				await attributeTurnCost(sharedDir, {
					agentId,
					turnNumber: turnSnapshot.turnNumber,
					windowStart: turnSnapshot.startedAt,
					windowEnd: new Date(),
					lifetimeCostUsd:
						ctx.statsCollector.getLifetime(agentId)?.lifetimeCostUsd ??
						turnSnapshot.costUsd,
				});
			} catch (e) {
				console.error("[agent-runner] cost attribution failed", {
					missionId,
					agentId,
					error: (e as Error).message,
				});
			}
		}
		// Close the browser session regardless of success or failure.
		await browseWebHandle?.close();
	}
}
