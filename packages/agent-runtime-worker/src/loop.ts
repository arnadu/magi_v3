import { randomUUID } from "node:crypto";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	ThinkingLevel,
	ToolResultMessage,
} from "@mariozechner/pi-ai";
import { pruneEphemeralResults } from "./context-utils.js";
import { callLlmWithRetry } from "./loop-llm-call.js";
import { checkToolArguments } from "./tool-args.js";
import type { MagiTool } from "./tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompleteFn = (
	model: Model<string>,
	context: Context,
	options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export interface InnerLoopConfig {
	model: Model<string>;
	/**
	 * Returns the system prompt for the current LLM call. Called once per
	 * loop iteration so changes from tool calls (e.g. the mental_map_* tools) are
	 * picked up before the next LLM call.
	 */
	getSystemPrompt: () => string;
	/**
	 * Returns the "dynamic context" message (current time + mental map — see
	 * prompt.ts's buildDynamicContextMessage) injected as messages[0]. Pulled
	 * fresh each iteration like getSystemPrompt, but only actually replaces
	 * messages[0] when the content has changed — see the OpenRouter caching
	 * investigation (#24): keeping the system prompt itself byte-stable
	 * across a session is what lets it stay cached/routed to the same backend
	 * even when the mental map or time block legitimately change mid-turn.
	 * Optional — omitted by sub-loop callers (reflection, Research, BrowseWeb)
	 * that have no equivalent concept.
	 */
	getDynamicContext?: () => string;
	task: string;
	tools: MagiTool[];
	signal?: AbortSignal;
	/**
	 * Prior conversation to resume. When provided, these messages are prepended
	 * before the new task message. onMessage does NOT fire for them — they are
	 * already persisted.
	 */
	previousMessages?: Message[];
	/**
	 * Injectable completion function for testing.
	 * Defaults to pi-ai's completeSimple.
	 */
	completeFn?: CompleteFn;
	/**
	 * Called immediately after each message is appended to the conversation.
	 * Receives the new message and an immutable snapshot of the full conversation
	 * up to that point. Use for persistence (repository.save) and/or streaming
	 * events to clients (SSE, WebSocket, etc.).
	 *
	 * Fires for: new user message, each assistant message, each tool result.
	 * Does NOT fire for previousMessages — those are already persisted.
	 */
	onMessage?: (
		msg: Message,
		allMessages: Message[],
		/** For an assistant message: the `callId` of the LLM call that produced it. */
		meta?: { callId?: string },
	) => Promise<void>;
	/**
	 * Maximum milliseconds to wait for a single tool call before recording a
	 * timeout error and continuing the loop. Default: 120_000 (2 minutes).
	 */
	toolTimeoutMs?: number;
	/**
	 * Maximum milliseconds to wait for a single LLM completion call before
	 * aborting it. Default: 480_000 (8 minutes) — generous for legitimate large/
	 * thinking responses, but bounded (unlike the prior state: only the 4-hour
	 * MAX_AGENT_RUN_SECONDS wall-clock guarded this, and a stalled streaming
	 * connection is not guaranteed to unwind promptly from that abort — see
	 * GitHub #17, a Research sub-loop's first LLM call hanging for days
	 * with no recovery). Applies to every runInnerLoop call, so a nested
	 * sub-loop (e.g. Research) is covered by the same guard as the main loop —
	 * no separate wiring needed there.
	 */
	llmCallTimeoutMs?: number;
	/**
	 * Maximum number of LLM calls before the loop exits regardless of whether
	 * the LLM requested further tool calls. Used by agentic tools (e.g. Research)
	 * to bound the cost of their sub-loops. Undefined = no cap (default for
	 * main agent loops).
	 */
	maxTurns?: number;
	/**
	 * Awaited before every LLM call; the mission's spend-cap pause parks a
	 * running turn here until the cap is raised. The loop re-checks `signal`
	 * when it returns, so an abort during the wait ends the run.
	 */
	beforeLlmCall?: () => Promise<void>;
	/**
	 * Called immediately after each LLM response (before tool execution).
	 * Receives the full context that was sent (system prompt + messages) and
	 * the response. Used to write the LLM call audit log.
	 */
	onLlmCall?: (event: {
		systemPrompt: string;
		messages: Message[];
		toolNames: string[];
		response: AssistantMessage;
		/**
		 * Identifies this call on both sides of the audit trail: the same id is
		 * handed to onMessage with the assistant message the call produced, so
		 * a log entry and a transcript message can be joined exactly rather
		 * than by position (retries, errors and sub-loop calls shift positions).
		 */
		callId: string;
	}) => Promise<void>;
	/**
	 * Called immediately after each tool result is produced (and persisted via
	 * onMessage). Receives the tool name, the original tool-call arguments, and
	 * whether the result was an error. Used by the statistics collector to count
	 * tool usage and extract touched files / sent messages / visited URLs.
	 *
	 * Fires once per tool call, including for unknown tools and timeouts (which
	 * are reported as errors). Runs in the daemon before the next LLM call, so it
	 * is outside the tool-executor subprocess sandbox.
	 */
	onToolResult?: (event: {
		toolName: string;
		args: Record<string, unknown>;
		isError: boolean;
	}) => Promise<void>;
	/**
	 * Extended thinking level to request on each LLM call.
	 * Only applied when model.reasoning === true; silently ignored otherwise.
	 */
	reasoning?: ThinkingLevel;
	/**
	 * Stable identifier passed through to the provider as options.sessionId —
	 * on OpenRouter (with Model.compat.sendSessionAffinityHeaders set, see
	 * models.ts's withOpenRouterAffinity) this becomes the x-session-id header,
	 * OpenRouter's own sticky-routing guarantee. Should stay stable for the
	 * agent's whole lifetime, not just one turn, to maximize routing/cache
	 * consistency across sessions. Ignored by providers that don't support it.
	 */
	sessionId?: string;
}

// Prune ephemeral tool results once context crosses this many tokens.
// Lowered from 160k (2026-08-10): on a long-running mission (100+ turns,
// individual turns with 100+ calls), the previously-pruned floor is never
// touched again within a session — only a whitelisted set of "ephemeral"
// tool results get stubbed, and only the rounds older than the last
// keepLastRounds — so context regularly climbed right back toward 160k and
// stayed there for many consecutive turns rather than returning to a low
// baseline. A lower threshold triggers pruning more often, keeping typical
// context (and therefore cost, latency, and llmCallLog size) smaller on
// average, at the cost of agents needing to re-fetch ephemeral tool output
// sooner. See docs/operational-resilience.md Layer 9 for the incident this
// was found investigating.
const MID_SESSION_PRUNE_THRESHOLD = 100_000;

export interface LoopResult {
	messages: Message[];
	turnCount: number;
}

// ---------------------------------------------------------------------------
// Inner loop
// ---------------------------------------------------------------------------

/** False once the run is aborted — before the pre-call gate, or while waiting in it. */
async function readyForCall(
	config: InnerLoopConfig,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	if (signal?.aborted) return false;
	await config.beforeLlmCall?.();
	return !signal?.aborted;
}

/**
 * Run the agent inner loop until the LLM makes no further tool calls.
 *
 * Termination: the LLM stops calling tools → the loop exits naturally.
 * No max-turn limit, no forced structured output. Modern LLMs reliably signal
 * completion by returning a plain text response with no tool calls.
 */
export async function runInnerLoop(
	config: InnerLoopConfig,
): Promise<LoopResult> {
	const { task, tools, signal, onMessage, onLlmCall, maxTurns } = config;

	// Seed with prior history if resuming; onMessage does not fire for these.
	const messages: Message[] = config.previousMessages
		? [...config.previousMessages]
		: [];

	// Dynamic-context message (current time + mental map) goes at index 0, ahead
	// of any resumed history — never routed through pushAndNotify/onMessage, so
	// it is never persisted to conversationMessages, exactly like systemPrompt
	// itself. Replaced in place (not re-pushed) whenever it changes; see
	// refreshDynamicContext.
	let lastDynamicContext = config.getDynamicContext?.();
	if (lastDynamicContext !== undefined) {
		messages.unshift({
			role: "user",
			content: lastDynamicContext,
			timestamp: Date.now(),
		});
	}

	/** Append a message and notify the caller immediately. */
	async function pushAndNotify(
		msg: Message,
		meta?: { callId?: string },
	): Promise<void> {
		messages.push(msg);
		await onMessage?.(msg, [...messages], meta);
	}

	// Append the new task as a user message — persisted before the first LLM
	// call so it is durable even if the process crashes mid-run.
	await pushAndNotify({ role: "user", content: task, timestamp: Date.now() });

	let turnCount = 0;

	while (true) {
		// The run's own signal ends the loop even when the provider ignores it (#65).
		if (!(await readyForCall(config, signal))) break;
		turnCount++;

		const systemPrompt = config.getSystemPrompt();
		if (config.getDynamicContext) {
			lastDynamicContext = refreshDynamicContext(
				messages,
				config.getDynamicContext(),
				lastDynamicContext,
			);
		}
		const context: Context = {
			systemPrompt,
			messages,
			tools: tools.map((t) => ({
				name: t.name,
				description: t.description,
				parameters: t.parameters,
			})),
		};

		// One id per logical call — retries are attempts at the same call.
		const callId = randomUUID();
		const assistantMessage = await callLlmWithRetry(config, context);
		if (onLlmCall) {
			await onLlmCall({
				systemPrompt,
				messages: [...messages], // snapshot before assistant msg is pushed
				toolNames: tools.map((t) => t.name),
				response: assistantMessage,
				callId,
			});
		}
		await pushAndNotify(assistantMessage, { callId });
		pruneIfLarge(messages, assistantMessage);

		// Abort on LLM error or explicit abort signal
		if (
			assistantMessage.stopReason === "error" ||
			assistantMessage.stopReason === "aborted"
		) {
			for (const result of interruptedToolResults(assistantMessage)) {
				await pushAndNotify(result);
			}
			break;
		}

		// ── Turn cap (agentic sub-loops) ────────────────────────────────────────
		if (maxTurns !== undefined && turnCount >= maxTurns) break;

		// ── Natural termination ─────────────────────────────────────────────────
		const toolCalls = assistantMessage.content.filter(
			(c) => c.type === "toolCall",
		);
		if (toolCalls.length === 0) break;

		// ── Tool execution ──────────────────────────────────────────────────────
		for (const block of toolCalls) {
			const toolResult = await executeToolCall(
				tools,
				block,
				signal,
				config.toolTimeoutMs ?? 120_000,
			);
			await pushAndNotify(toolResult);
			await config.onToolResult?.({
				toolName: block.name,
				args: (block.arguments ?? {}) as Record<string, unknown>,
				isError: toolResult.isError ?? false,
			});
		}
	}

	return { messages, turnCount };
}

/**
 * Pull-based, like getSystemPrompt — but messages[0] is replaced only when
 * the content actually changed, so the (much larger, cacheable) history after
 * it stays byte-identical across iterations where nothing changed. Returns
 * the content now in place.
 */
function refreshDynamicContext(
	messages: Message[],
	fresh: string,
	last: string | undefined,
): string | undefined {
	if (fresh === last) return last;
	messages[0] = { role: "user", content: fresh, timestamp: Date.now() };
	return fresh;
}

/**
 * Mid-session pruning: stub old ephemeral tool results and strip thinking
 * blocks when context grows large, to prevent hitting the 200k limit.
 */
function pruneIfLarge(
	messages: Message[],
	assistantMessage: AssistantMessage,
): void {
	// Same measure as the reflection trigger (peakContextTokens): tokens just
	// written to the cache are part of the context too (LP1).
	const ctxSize =
		(assistantMessage.usage?.input ?? 0) +
		(assistantMessage.usage?.cacheRead ?? 0) +
		(assistantMessage.usage?.cacheWrite ?? 0);
	if (ctxSize <= MID_SESSION_PRUNE_THRESHOLD) return;
	const pruned = pruneEphemeralResults(messages, 2);
	messages.splice(0, messages.length, ...pruned);
	console.warn(
		`[loop] context ${Math.round(ctxSize / 1_000)}k tokens — pruned ephemeral tool results`,
	);
}

/**
 * Synthetic results for the tool calls an errored or aborted message carries.
 * The loop is ending without executing them — a stream that was cut off
 * (abort, or an error mid-stream) can still carry parsed toolCall blocks.
 * Left as-is, that's a permanent dangling tool_use in persisted history:
 * every future replay (regardless of provider) fails identically, since the
 * provider's own tool_use/tool_result pairing validation rejects it.
 * Persisting matching results at write time keeps history self-consistent
 * from the moment it's written — belt and suspenders alongside
 * convertToLlm's read-time patch (reflection.ts), which stays as a backstop
 * for older corruption. Found live: a copilot model switch mid-turn aborted
 * a call with an in-flight tool_use, corrupting history for every session
 * after.
 */
function interruptedToolResults(
	assistantMessage: AssistantMessage,
): ToolResultMessage[] {
	return assistantMessage.content.flatMap((block) =>
		block.type === "toolCall"
			? [
					makeError(
						block,
						"Tool result was not saved — the session was interrupted before this tool completed.",
					),
				]
			: [],
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Race a promise against a timeout. Rejects with a descriptive Error if the
 * timeout fires first, and calls `onTimeout` so the work itself can be
 * cancelled — waiting less is not the same as stopping it (T3).
 */
function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
	onTimeout: () => void,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			onTimeout();
			reject(new Error(`Tool "${label}" timed out after ${ms}ms`));
		}, ms);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

/**
 * One tool call: schema check (LP2), the run's abort state, the per-tool
 * timeout, and every failure folded into an isError result the model reads.
 */
async function executeToolCall(
	tools: MagiTool[],
	block: { id: string; name: string; arguments: unknown },
	signal: AbortSignal | undefined,
	toolTimeoutMs: number,
): Promise<ToolResultMessage> {
	const tool = tools.find((t) => t.name === block.name);
	if (!tool) return makeError(block, `Tool "${block.name}" not found`);
	if (signal?.aborted) {
		return makeError(
			block,
			"Run aborted (wall-clock limit or shutdown) before this tool ran",
		);
	}
	const checked = checkToolArguments(tool, block);
	if (!checked.ok) return makeError(block, checked.message);
	// The call's own signal: aborted by the run's (wall clock, shutdown) or by
	// its timeout, so a timed-out Bash command is killed, not abandoned.
	const call = new AbortController();
	const onRunAbort = () => call.abort();
	signal?.addEventListener("abort", onRunAbort, { once: true });
	const timeoutMs = Math.max(
		toolTimeoutMs,
		tool.maxRuntimeMs?.(checked.args) ?? 0,
	);
	try {
		const result = await withTimeout(
			tool.execute(block.id, checked.args, call.signal),
			timeoutMs,
			block.name,
			() => call.abort(),
		);
		return {
			role: "toolResult",
			toolCallId: block.id,
			toolName: block.name,
			content: result.content,
			isError: result.isError ?? false,
			timestamp: Date.now(),
		};
	} catch (e) {
		return makeError(block, e instanceof Error ? e.message : String(e));
	} finally {
		signal?.removeEventListener("abort", onRunAbort);
	}
}

function makeError(
	toolCall: { id: string; name: string },
	text: string,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text }],
		isError: true,
		timestamp: Date.now(),
	};
}
