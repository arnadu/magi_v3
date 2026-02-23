import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	ToolResultMessage,
} from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
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
	systemPrompt: string;
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
}

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
		systemPrompt,
		task,
		tools,
		signal,
		onMessage,
		toolTimeoutMs = 120_000,
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
		const assistantMessage = await completeFn(model, context, { signal });
		await pushAndNotify(assistantMessage);

		// Abort on LLM error or explicit abort signal
		if (
			assistantMessage.stopReason === "error" ||
			assistantMessage.stopReason === "aborted"
		) {
			break;
		}

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
