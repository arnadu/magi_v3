/**
 * Sprint 9 — Context Management: Reflection and Tool-Result Scoping.
 *
 * See ADR-0009 for the full design.
 */

import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
	UserMessage,
} from "@mariozechner/pi-ai";
import type { AnomalyRecorder } from "./anomaly.js";

import { pruneEphemeralResults } from "./context-utils.js";
import type {
	ConversationRepository,
	StoredMessage,
	SummaryMessage,
} from "./conversation-repository.js";
import { runInnerLoop } from "./loop.js";
import { createMentalMapTools } from "./mental-map.js";
import { loadPrompt } from "./prompts.js";

// ---------------------------------------------------------------------------
// Tool-result scoping
// ---------------------------------------------------------------------------

/**
 * Convert stored conversation history into the message list passed to the LLM.
 *
 * After compaction a session's history contains only summary messages — the raw
 * messages from previous sessions have been marked compacted and are excluded by
 * the repository's load() filter. This function converts those summaries into
 * user-role messages so the LLM sees them in natural conversation form.
 *
 * All other messages (user, assistant, toolResult) are passed through unchanged.
 * They represent the current in-flight session and are never collapsed here.
 */
/**
 * Tool calls in the stored history that never got a result (the daemon
 * died, or was replaced by a machine upgrade, between saving the assistant
 * message and the tool's completion). `convertToLlm` papers over them with a
 * synthetic result on every load; persisting that result once — what
 * `syntheticResultsFor` builds — stops the history from growing a fresh
 * placeholder turn after turn (#56: 50 injected results until the
 * prompt exceeded the model's window).
 */
export function findDanglingToolCalls(
	history: StoredMessage[],
): Array<{ turnNumber: number; id: string; name: string }> {
	const resultIds = new Set<string>();
	for (const sm of history) {
		if (sm.message.role === "toolResult") {
			resultIds.add((sm.message as ToolResultMessage).toolCallId);
		}
	}
	const out: Array<{ turnNumber: number; id: string; name: string }> = [];
	for (const sm of history) {
		if (sm.message.role !== "assistant") continue;
		for (const block of (sm.message as AssistantMessage).content) {
			if (block.type === "toolCall" && !resultIds.has(block.id)) {
				out.push({ turnNumber: sm.turnNumber, id: block.id, name: block.name });
			}
		}
	}
	return out;
}

export function syntheticResultsFor(
	dangling: Array<{ turnNumber: number; id: string; name: string }>,
): StoredMessage[] {
	return dangling.map((d) => ({
		turnNumber: d.turnNumber,
		message: {
			role: "toolResult",
			toolCallId: d.id,
			toolName: d.name,
			content: [
				{
					type: "text",
					text: `Tool result was lost — the session was interrupted before ${d.name} completed. Treat the call as failed; re-run it only if its effect is not visible.`,
				},
			],
			isError: true,
			timestamp: Date.now(),
		} as ToolResultMessage,
	}));
}

export function convertToLlm(stored: StoredMessage[]): Message[] {
	const raw = stored.flatMap((sm): Message[] => {
		const m = sm.message;
		if (m.role === "summary") {
			return [
				{
					role: "user" as const,
					content: `[Session history summary]\n${(m as SummaryMessage).content}`,
					timestamp: Date.now(),
				},
			];
		}
		return [m as Message];
	});

	// Collect all tool_use and tool_result IDs present in the raw history.
	const toolUseIds = new Set<string>();
	const toolResultIds = new Set<string>();
	for (const m of raw) {
		if (m.role === "assistant") {
			for (const block of (m as AssistantMessage).content) {
				if (block.type === "toolCall") {
					toolUseIds.add((block as { type: "toolCall"; id: string }).id);
				}
			}
		} else if (m.role === "toolResult") {
			toolResultIds.add((m as ToolResultMessage).toolCallId);
		}
	}

	// Pass 1: drop orphaned tool_results (result exists but no matching tool_use).
	// Caused by a crash that lost the assistant message but kept the result.
	const pass1 = raw.filter((m) => {
		if (m.role === "toolResult") {
			const id = (m as ToolResultMessage).toolCallId;
			if (!toolUseIds.has(id)) {
				console.error(
					`[convertToLlm] dropping orphaned tool_result ${id} — no matching tool_use`,
				);
				return false;
			}
		}
		return true;
	});

	// Pass 2: inject synthetic error results for tool_uses with no matching result.
	// Caused by a crash between saving the assistant message and executing the tool.
	// Injected immediately after the offending assistant message so the sequence
	// remains valid: assistant[tool_use] → user[tool_result].
	const out: Message[] = [];
	for (const m of pass1) {
		out.push(m);
		if (m.role === "assistant") {
			for (const block of (m as AssistantMessage).content) {
				if (block.type === "toolCall") {
					const tc = block as { type: "toolCall"; id: string; name: string };
					if (!toolResultIds.has(tc.id)) {
						console.error(
							`[convertToLlm] injecting synthetic result for tool_use ${tc.id} (${tc.name}) — result was never saved`,
						);
						out.push({
							role: "toolResult",
							toolCallId: tc.id,
							toolName: tc.name,
							content: [
								{
									type: "text",
									text: "Tool result was not saved — the session was interrupted before this tool completed.",
								},
							],
							isError: true,
							timestamp: Date.now(),
						} as ToolResultMessage);
					}
				}
			}
		}
	}
	// Prune ephemeral tool results and old thinking blocks before handing the
	// history to the inner loop, keeping the baseline context lean.
	return pruneEphemeralResults(out, 2);
}

// ---------------------------------------------------------------------------
// Session serialiser
// ---------------------------------------------------------------------------

/**
 * Produce a human-readable transcript of session messages for the reflection
 * LLM prompt. Tool results are truncated to 2 000 chars — the reflection needs
 * enough context to summarise, not the full raw body.
 */
function serializeForReflection(messages: Message[]): string {
	const lines: string[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			const um = msg as UserMessage;
			const text =
				typeof um.content === "string"
					? um.content
					: um.content
							.filter((b) => b.type === "text")
							.map((b) => b.text)
							.join("");
			lines.push(`USER: ${text}`);
		} else if (msg.role === "assistant") {
			const am = msg as AssistantMessage;
			for (const block of am.content) {
				if (block.type === "text" && block.text?.trim()) {
					const t = block.text.trim();
					lines.push(`AGENT: ${t.length > 800 ? `${t.slice(0, 800)}…` : t}`);
				} else if (block.type === "toolCall") {
					const args = JSON.stringify(block.arguments ?? {});
					const preview = args.length > 200 ? `${args.slice(0, 200)}…` : args;
					lines.push(`TOOL CALL: ${block.name}(${preview})`);
				}
			}
		} else if (msg.role === "toolResult") {
			const tr = msg as ToolResultMessage;
			const text = tr.content
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("")
				.trim();
			const preview = text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
			const label = tr.isError ? "TOOL ERROR" : "TOOL RESULT";
			lines.push(`${label} (${tr.toolName}): ${preview}`);
		}
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Reflection system prompt
// ---------------------------------------------------------------------------

function buildReflectionSystemPrompt(): string {
	return loadPrompt("reflection.md");
}

// ---------------------------------------------------------------------------
// Reflection runner
// ---------------------------------------------------------------------------

export interface ReflectionContext {
	model: import("@mariozechner/pi-ai").Model<string>;
	/** Returns the current mental map HTML (or null if not yet set). */
	getMentalMap: () => string | null;
	/** Called with the updated HTML after a successful mental_map_* edit. */
	setMentalMap: (html: string) => void;
	conversationRepo: ConversationRepository;
	/** The turn number of the session being reflected on (used to compute the compaction cutpoint). */
	turnNumber: number;
	/** Prior session summaries extracted from the loaded history (oldest first). */
	previousSummaries: string[];
	/**
	 * Optional hook called for every message produced by the reflection inner
	 * loop. Used by the daemon to feed reflection LLM calls into the usage
	 * accumulator and cost dashboard — without this, reflection costs are silent.
	 */
	onMessage?: (msg: Message) => void | Promise<void>;
	/**
	 * Optional hook called immediately after each LLM response in the reflection
	 * inner loop. Used by the LLM call audit log to record reflection calls.
	 */
	onLlmCall?: (event: {
		systemPrompt: string;
		messages: import("@mariozechner/pi-ai").Message[];
		toolNames: string[];
		response: AssistantMessage;
	}) => Promise<void>;
}

/**
 * Run a reflection pass at the start of a new session (before the agent's
 * inner loop), consolidating the previous session into a Mental Map update
 * and a narrative summary.
 *
 * 1. Builds the reflection prompt from ctx.previousSummaries (passed in by the
 *    caller to avoid a redundant DB round-trip), the current Mental Map, and the
 *    full session transcript.
 * 2. Runs a mini inner loop with only the mental-map tools so the reflection
 *    LLM edits the Mental Map directly via the same tools the agent uses.
 *    Elements without an id attribute are inherently protected — the tools
 *    require an id to address any element.
 * 3. Extracts the narrative summary from the final assistant text response.
 * 4. Saves the summary at turnNumber+1 BEFORE compacting old turns (crash-safe:
 *    a crash between the two operations never loses the summary; no transactions
 *    needed because the summary is above the compact cutpoint).
 * 5. Compacts ALL messages from the previous session (marks as compacted;
 *    documents retained in MongoDB for audit/RAG).
 *
 * No-op if sessionMessages is empty.
 */
export async function runReflection(
	agentId: string,
	missionId: string,
	sessionMessages: Message[],
	ctx: ReflectionContext,
): Promise<void> {
	if (sessionMessages.length === 0) return;

	// 1. Build the reflection prompt: prior summaries + Mental Map + transcript.
	const transcript = serializeForReflection(sessionMessages);
	const currentHtml = ctx.getMentalMap();
	const priorSummaryBlock =
		ctx.previousSummaries.length > 0
			? `PRIOR SESSION SUMMARIES (oldest first — extend, do not repeat):\n${"─".repeat(60)}\n${ctx.previousSummaries.join(`\n${"─".repeat(60)}\n`)}\n\n`
			: "";
	const mentalMapBlock = currentHtml
		? `CURRENT MENTAL MAP:\n${currentHtml}\n\n`
		: "";
	const userPrompt = `${priorSummaryBlock}${mentalMapBlock}${"─".repeat(60)}\n\nSESSION TRANSCRIPT:\n${transcript}`;

	// 2. Run reflection loop with the mental_map_* tools as the only ones available.
	//    Messages are persisted with isReflection:true so they are excluded from
	//    the agent's prompt context but visible in MongoDB for debugging.
	//
	//    Partial-failure note: if the process crashes mid-loop (after some
	//    mental-map edits but before the summary is saved), the next wakeup
	//    retries reflection on the same uncompacted session. The orphaned reflection
	//    messages from the failed attempt stay in MongoDB but are harmless —
	//    they are filtered out of load() and compact() never targets their
	//    turnNumber (reflectionTurnNumber = ctx.turnNumber + 1 is above the
	//    compact cutpoint). mental_map_update uses replace semantics so the re-run
	//    is idempotent from the Mental Map's perspective.
	const reflectionTurnNumber = ctx.turnNumber + 1;
	const mentalMapTools = createMentalMapTools(
		ctx.getMentalMap,
		ctx.setMentalMap,
	);
	const reflectionSystemPrompt = buildReflectionSystemPrompt();
	const { messages: reflectionMessages } = await runInnerLoop({
		model: ctx.model,
		getSystemPrompt: () => reflectionSystemPrompt,
		task: userPrompt,
		tools: mentalMapTools,
		onMessage: async (msg) => {
			await ctx.conversationRepo.append(agentId, missionId, [
				{ turnNumber: reflectionTurnNumber, message: msg, isReflection: true },
			]);
			await ctx.onMessage?.(msg);
		},
		onLlmCall: ctx.onLlmCall,
	});

	// 3. Extract summary from the final assistant text response.
	const lastAssistant = [...reflectionMessages]
		.reverse()
		.find((m): m is AssistantMessage => m.role === "assistant");
	const summary =
		lastAssistant?.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("")
			.trim() ?? "";

	// 4. Save the summary at reflectionTurnNumber BEFORE compacting.
	//    isReflection is NOT set — the summary must appear in load() so the agent
	//    sees it as prior context on the next wakeup.
	//    The summary lives above the compact cutpoint so compact() can never catch it.
	if (!summary) {
		// Compacting without a summary would delete the session's memory and
		// replace it with nothing (audit RF1). Leave the history uncompacted —
		// the next wakeup reflects again — and say so loudly.
		console.error(
			`[reflection] ${agentId}: reflection produced no summary { missionId: "${missionId}", turn: ${ctx.turnNumber} } — history left uncompacted, retried at the next wakeup`,
		);
		return;
	}
	// The summary record also carries the post-reflection mental map, so a
	// crash between here and the next assistant message cannot lose the
	// edits reflection just made (audit RF3).
	const summaryMsg: SummaryMessage = { role: "summary", content: summary };
	await ctx.conversationRepo.append(agentId, missionId, [
		{
			turnNumber: reflectionTurnNumber,
			message: summaryMsg,
			mentalMapHtml: ctx.getMentalMap() ?? undefined,
		},
	]);

	// 5. Compact ALL messages from the previous session.
	//    keepFrom = turnNumber + 1 targets everything with turnNumber < turnNumber+1,
	//    i.e. the entire session just reflected on.
	await ctx.conversationRepo.compact(agentId, missionId, ctx.turnNumber + 1);
}

/**
 * A reflection that throws (provider error, abort) used to fail the whole
 * turn before the loop ran, and since nothing was compacted the next wakeup
 * retried the same reflection first — a livelock while the provider was
 * unhappy (audit RF2). The turn proceeds on the uncompacted history and the
 * failure is recorded as a soft anomaly.
 */
export async function reflectGuarded(
	ctx: { anomalyRecorder?: Pick<AnomalyRecorder, "record"> },
	agentId: string,
	missionId: string,
	run: () => Promise<void>,
): Promise<void> {
	const recorder = ctx.anomalyRecorder;
	try {
		await run();
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		console.error(
			`[runAgent] ${agentId}: reflection failed { missionId: "${missionId}", error: ${JSON.stringify(message)} } — continuing the turn without compaction`,
		);
		await recorder
			?.record({
				missionId,
				agentId,
				category: "reflection-failed",
				severity: "soft",
				message: `Reflection for "${agentId}" failed: ${message}. The turn ran on uncompacted history; it is retried at the next wakeup.`,
			})
			.catch((e: unknown) =>
				console.error(
					`[reflection] could not record the reflection-failed anomaly { missionId: ${missionId}, agentId: ${agentId}, error: ${(e as Error).message} }`,
				),
			);
	}
}

/** Reflect when the previous session used at least this fraction of the model's window… */
export const REFLECTION_CTX_FRACTION = 0.6;
/**
 * …or this many tokens, whichever is lower. The fraction exists so a small
 * window ever reaches the threshold; the cap keeps a large one from never
 * compacting — at 60% of a 1M window (z-ai/glm-5.2) a mission copilot ran
 * every call on ~300k tokens of uncompacted history, $0.10–0.25 each.
 */
export const REFLECTION_MAX_TOKENS = 120_000;
/** After this many zero-output turns with a context above the forced threshold, reflect regardless (#64). */
export const FORCE_REFLECTION_AFTER_ZERO_OUTPUT_TURNS = 3;
export const FORCE_REFLECTION_FRACTION = 0.4;
export const FORCE_REFLECTION_MAX_TOKENS = 80_000;

export function shouldForceReflection(
	peakInputTokens: number,
	contextWindow: number,
	zeroOutputStreak: number,
): boolean {
	return (
		zeroOutputStreak >= FORCE_REFLECTION_AFTER_ZERO_OUTPUT_TURNS &&
		peakInputTokens >=
			Math.min(
				FORCE_REFLECTION_FRACTION * contextWindow,
				FORCE_REFLECTION_MAX_TOKENS,
			)
	);
}

/**
 * The reflection decision. Threshold relative to the model's own window
 * (a 32k-window model never reached one computed for 200k), capped in
 * absolute tokens (a 1M window otherwise never compacts), and overridable
 * via REFLECTION_THRESHOLD (tokens) for tests; plus the circuit breaker:
 * ephemeral pruning can hold the context just under the threshold while the
 * agent produces nothing turn after turn — a dead zone where it can neither
 * compact nor progress (#64).
 */
export async function shouldReflect(input: {
	peakInputTokens: number;
	contextWindow: number;
	zeroOutputStreak: number;
}): Promise<boolean> {
	const threshold = process.env.REFLECTION_THRESHOLD
		? Number.parseInt(process.env.REFLECTION_THRESHOLD, 10)
		: Math.min(
				REFLECTION_CTX_FRACTION * input.contextWindow,
				REFLECTION_MAX_TOKENS,
			);
	return (
		input.peakInputTokens >= threshold ||
		shouldForceReflection(
			input.peakInputTokens,
			input.contextWindow,
			input.zeroOutputStreak,
		)
	);
}

/** Load the history, persisting one synthetic error result per dangling tool call first (#56). */
export async function loadRepairedHistory(
	repo: Pick<ConversationRepository, "append" | "load">,
	agentId: string,
	missionId: string,
): Promise<StoredMessage[]> {
	const history = await repo.load(agentId, missionId);
	const dangling = findDanglingToolCalls(history);
	if (dangling.length === 0) return history;
	console.warn(
		`[runAgent] ${agentId}: ${dangling.length} tool call(s) without a stored result (${dangling.map((d) => d.name).join(", ")}) — persisting synthetic error results once`,
	);
	await repo.append(agentId, missionId, syntheticResultsFor(dangling));
	return repo.load(agentId, missionId);
}

/**
 * One reflection pass over the previous session, then the reloaded history
 * (compacted documents excluded, the new summary visible).
 */
export async function reflectSession(
	ctx: {
		model: Parameters<typeof runReflection>[3]["model"];
		conversationRepo: ConversationRepository;
		onMessage?: (msg: Message, allMessages: Message[]) => void | Promise<void>;
	},
	agentId: string,
	missionId: string,
	input: {
		sessionMessages: Message[];
		nonSummaryHistory: StoredMessage[];
		history: StoredMessage[];
		getMentalMap: () => string;
		setMentalMap: (html: string) => void;
		makeOnLlmCall: (
			turnNumber: number,
			isReflection: boolean,
		) => Parameters<typeof runReflection>[3]["onLlmCall"];
	},
): Promise<StoredMessage[]> {
	const lastTurnNumber = input.nonSummaryHistory.reduce(
		(max, sm) => Math.max(max, sm.turnNumber),
		-1,
	);
	const previousSummaries = input.history
		.filter((sm) => sm.message.role === "summary")
		.map((sm) => (sm.message as SummaryMessage).content);
	await runReflection(agentId, missionId, input.sessionMessages, {
		model: ctx.model,
		getMentalMap: input.getMentalMap,
		setMentalMap: input.setMentalMap,
		conversationRepo: ctx.conversationRepo,
		turnNumber: lastTurnNumber,
		previousSummaries,
		onMessage: ctx.onMessage ? (msg) => ctx.onMessage?.(msg, []) : undefined,
		onLlmCall: input.makeOnLlmCall(lastTurnNumber + 1, true),
	});
	return ctx.conversationRepo.load(agentId, missionId);
}
