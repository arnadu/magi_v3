import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	ThinkingLevel,
	ToolResultMessage,
} from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import { pruneEphemeralResults } from "./context-utils.js";
import type { MagiTool } from "./tools.js";

// ---------------------------------------------------------------------------
// Helpers

function is429(msg: AssistantMessage): boolean {
	return (
		msg.stopReason === "error" && (msg.errorMessage?.includes("429") ?? false)
	);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * A child AbortSignal that aborts when `parent` aborts OR after `ms` — real
 * cancellation (not a Promise.race that leaves the original call running), so
 * an LLM call that respects its signal (pi-ai's providers thread it into the
 * underlying fetch) actually gets torn down instead of hanging until the
 * caller's own, much longer wall-clock limit (or never, if that abort doesn't
 * unwind a stalled connection either). Always call `cleanup()` once the
 * guarded operation settles, or the timer/listener outlive it.
 */
function deriveDeadline(
	ms: number,
	parent?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), ms);
	const forward = () => ac.abort();
	parent?.addEventListener("abort", forward, { once: true });
	return {
		signal: ac.signal,
		cleanup: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", forward);
		},
	};
}

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
	 * loop iteration so changes from tool calls (e.g. UpdateMentalMap) are
	 * picked up before the next LLM call.
	 */
	getSystemPrompt: () => string;
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
	onMessage?: (msg: Message, allMessages: Message[]) => Promise<void>;
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
	 * GitHub issue #17, a Research sub-loop's first LLM call hanging for days
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
	 * Called immediately after each LLM response (before tool execution).
	 * Receives the full context that was sent (system prompt + messages) and
	 * the response. Used to write the LLM call audit log.
	 */
	onLlmCall?: (event: {
		systemPrompt: string;
		messages: Message[];
		toolNames: string[];
		response: AssistantMessage;
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
}

// Prune ephemeral tool results when context exceeds 80% of the 200k window.
const MID_SESSION_PRUNE_THRESHOLD = 160_000;

export interface LoopResult {
	messages: Message[];
	turnCount: number;
}

// ---------------------------------------------------------------------------
// Inner loop
// ---------------------------------------------------------------------------

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
	const {
		model,
		task,
		tools,
		signal,
		onMessage,
		onLlmCall,
		onToolResult,
		toolTimeoutMs = 120_000,
		llmCallTimeoutMs = 480_000,
		maxTurns,
		reasoning,
	} = config;
	const completeFn: CompleteFn = config.completeFn ?? completeSimple;

	// Seed with prior history if resuming; onMessage does not fire for these.
	const messages: Message[] = config.previousMessages
		? [...config.previousMessages]
		: [];

	/** Append a message and notify the caller immediately. */
	async function pushAndNotify(msg: Message): Promise<void> {
		messages.push(msg);
		await onMessage?.(msg, [...messages]);
	}

	// Append the new task as a user message — persisted before the first LLM
	// call so it is durable even if the process crashes mid-run.
	await pushAndNotify({ role: "user", content: task, timestamp: Date.now() });

	let turnCount = 0;

	while (true) {
		turnCount++;

		const systemPrompt = config.getSystemPrompt();

		const context: Context = {
			systemPrompt,
			messages,
			tools: tools.map((t) => ({
				name: t.name,
				description: t.description,
				parameters: t.parameters,
			})),
		};

		// ── LLM call ────────────────────────────────────────────────────────────
		// Cap max output tokens: some OpenRouter model entries set maxTokens == contextWindow
		// (no room for input). Mirror the 32k cap that the Anthropic provider uses.
		const maxOutputTokens = Math.min(model.maxTokens, 32_000);
		// Each attempt gets its own bounded signal (derived from the outer one)
		// so a stalled call is actually torn down within llmCallTimeoutMs rather
		// than only by the caller's much longer wall-clock limit — see
		// deriveDeadline's doc comment.
		async function callWithDeadline(): Promise<AssistantMessage> {
			const deadline = deriveDeadline(llmCallTimeoutMs, signal);
			const callOpts: SimpleStreamOptions = {
				signal: deadline.signal,
				maxTokens: maxOutputTokens,
				// Enable extended thinking only when the model declares reasoning support.
				...(reasoning && model.reasoning ? { reasoning } : {}),
			};
			try {
				return await completeFn(model, context, callOpts);
			} finally {
				deadline.cleanup();
			}
		}
		let assistantMessage = await callWithDeadline();
		// Retry on 429 (upstream rate-limit) with exponential backoff.
		for (let attempt = 1; attempt <= 3 && is429(assistantMessage); attempt++) {
			const delayMs = 5_000 * 2 ** (attempt - 1); // 5s, 10s, 20s
			console.warn(
				`[loop] 429 rate-limit from ${model.id} — retrying in ${delayMs / 1000}s (attempt ${attempt}/3)`,
			);
			await sleep(delayMs, signal);
			if (signal?.aborted) break;
			assistantMessage = await callWithDeadline();
		}
		if (onLlmCall) {
			await onLlmCall({
				systemPrompt,
				messages: [...messages], // snapshot before assistant msg is pushed
				toolNames: tools.map((t) => t.name),
				response: assistantMessage,
			});
		}
		await pushAndNotify(assistantMessage);

		// Mid-session pruning: stub old ephemeral tool results and strip thinking
		// blocks when context grows large, to prevent hitting the 200k limit.
		const ctxSize =
			(assistantMessage.usage?.input ?? 0) +
			(assistantMessage.usage?.cacheRead ?? 0);
		if (ctxSize > MID_SESSION_PRUNE_THRESHOLD) {
			const pruned = pruneEphemeralResults(messages, 2);
			messages.splice(0, messages.length, ...pruned);
			console.warn(
				`[loop] context ${Math.round(ctxSize / 1_000)}k tokens — pruned ephemeral tool results`,
			);
		}

		// Abort on LLM error or explicit abort signal
		if (
			assistantMessage.stopReason === "error" ||
			assistantMessage.stopReason === "aborted"
		) {
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
			if (block.type !== "toolCall") continue;

			const tool = tools.find((t) => t.name === block.name);
			let toolResult: ToolResultMessage;

			if (!tool) {
				toolResult = makeError(block, `Tool "${block.name}" not found`);
			} else {
				try {
					const result = await withTimeout(
						tool.execute(block.id, block.arguments, signal),
						toolTimeoutMs,
						block.name,
					);
					toolResult = {
						role: "toolResult",
						toolCallId: block.id,
						toolName: block.name,
						content: result.content,
						isError: result.isError ?? false,
						timestamp: Date.now(),
					};
				} catch (e) {
					toolResult = makeError(
						block,
						e instanceof Error ? e.message : String(e),
					);
				}
			}

			await pushAndNotify(toolResult);

			if (onToolResult) {
				await onToolResult({
					toolName: block.name,
					args: (block.arguments ?? {}) as Record<string, unknown>,
					isError: toolResult.isError ?? false,
				});
			}
		}
	}

	return { messages, turnCount };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Race a promise against a timeout. Rejects with a descriptive Error if the
 * timeout fires first. The original promise is not cancelled — this only
 * controls how long the caller waits.
 */
function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Tool "${label}" timed out after ${ms}ms`)),
			ms,
		);
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
