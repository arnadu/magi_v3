/**
 * One LLM call of the inner loop: a per-call deadline that really cancels a
 * stalled call, and backoff retries for rate limits and known-transient
 * provider errors.
 */

import type {
	AssistantMessage,
	Context,
	SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { CompleteFn, InnerLoopConfig } from "./loop.js";
import { piModels } from "./models.js";

export function is429(msg: AssistantMessage): boolean {
	return (
		msg.stopReason === "error" && (msg.errorMessage?.includes("429") ?? false)
	);
}

// Substrings of known-transient provider errors (stream interruptions, upstream
// timeouts, connection drops) that recover within seconds — observed repeatedly
// in production (#38) ending a turn and losing in-progress work for no
// reason, since the provider itself was back within the same session.
const TRANSIENT_ERROR_PATTERNS = [
	"stream ended",
	"idle timeout",
	"connection error",
	"connection reset",
	"econnreset",
];

export function isTransientError(msg: AssistantMessage): boolean {
	if (msg.stopReason !== "error" || !msg.errorMessage) return false;
	const lower = msg.errorMessage.toLowerCase();
	return TRANSIENT_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

function isRetryable(msg: AssistantMessage): boolean {
	return is429(msg) || isTransientError(msg);
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

/**
 * One logical LLM call. Each attempt gets its own bounded signal (derived
 * from the run's) so a stalled call is torn down within llmCallTimeoutMs
 * rather than only by the caller's much longer wall-clock limit — see
 * deriveDeadline. A 429 or known-transient provider error is retried with
 * exponential backoff (5 s, 10 s, 20 s): both recover within seconds and
 * shouldn't end the turn.
 */
export async function callLlmWithRetry(
	config: InnerLoopConfig,
	context: Context,
): Promise<AssistantMessage> {
	const { model, signal, reasoning, sessionId } = config;
	const llmCallTimeoutMs = config.llmCallTimeoutMs ?? 480_000;
	const completeFn: CompleteFn =
		config.completeFn ??
		((model, context, options) =>
			piModels.completeSimple(model, context, options));
	// Cap max output tokens: some OpenRouter model entries set maxTokens == contextWindow
	// (no room for input). Mirror the 32k cap that the Anthropic provider uses.
	const maxOutputTokens = Math.min(model.maxTokens, 32_000);
	async function callWithDeadline(): Promise<AssistantMessage> {
		const deadline = deriveDeadline(llmCallTimeoutMs, signal);
		const callOpts: SimpleStreamOptions = {
			signal: deadline.signal,
			maxTokens: maxOutputTokens,
			// Enable extended thinking only when the model declares reasoning support.
			...(reasoning && model.reasoning ? { reasoning } : {}),
			...(sessionId ? { sessionId } : {}),
		};
		try {
			const msg = await completeFn(model, context, callOpts);
			// The provider reports its own deadline abort as "aborted", the same
			// as a run abort; a stalled call is an LLM error (alerted, cooled
			// down), not the operator stopping the run (LP4).
			if (msg.stopReason === "aborted" && !signal?.aborted) {
				return {
					...msg,
					stopReason: "error",
					errorMessage: `LLM call exceeded its ${llmCallTimeoutMs / 1000}s deadline`,
				};
			}
			return msg;
		} finally {
			deadline.cleanup();
		}
	}
	let assistantMessage = await callWithDeadline();
	for (
		let attempt = 1;
		attempt <= 3 && isRetryable(assistantMessage);
		attempt++
	) {
		const delayMs = 5_000 * 2 ** (attempt - 1);
		const reason = is429(assistantMessage)
			? "429 rate-limit"
			: `transient error (${assistantMessage.errorMessage})`;
		console.warn(
			`[loop] ${reason} from ${model.id} — retrying in ${delayMs / 1000}s (attempt ${attempt}/3)`,
		);
		await sleep(delayMs, signal);
		if (signal?.aborted) break;
		assistantMessage = await callWithDeadline();
	}
	return assistantMessage;
}
