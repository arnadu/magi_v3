import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Tool classification
// ---------------------------------------------------------------------------

/**
 * Tools whose results are large and transient — safe to stub out after the
 * agent has moved past them. Durable tools (WriteFile, PostMessage, …) are
 * never touched: their small confirmations are cheap and often referred back to.
 */
export const EPHEMERAL_TOOLS = new Set([
	"Bash",
	"SearchWeb",
	"FetchUrl",
	"BrowseWeb",
	"ReadFile",
	"InspectImage",
]);

export const PRUNED_STUB =
	"[Result pruned to reduce context size. Use AnalyzeMemories to retrieve if needed.]";

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/**
 * Two pruning passes over a message array:
 *
 *  1. Ephemeral tool results — replace content with PRUNED_STUB for all
 *     rounds except the last `keepLastRounds` (default 2). A "round" is one
 *     assistant message plus all tool results that follow it.
 *
 *  2. Thinking blocks — strip `{ type: "thinking" }` content blocks from
 *     every assistant message except the most recent round (always 1,
 *     regardless of `keepLastRounds`). Keeps only the current round's
 *     reasoning, consistent with Anthropic's multi-turn thinking guidance.
 *
 * Already-stubbed results are left as-is (idempotent).
 * Returns a new array; does not mutate the input.
 */
export function pruneEphemeralResults(
	messages: Message[],
	keepLastRounds = 2,
): Message[] {
	const assistantIdxs: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === "assistant") assistantIdxs.push(i);
	}
	if (assistantIdxs.length === 0) return [...messages];

	// Ephemeral tool results: prune rounds older than the last keepLastRounds.
	const toolPruneBeforeIdx =
		assistantIdxs.length <= keepLastRounds
			? -1
			: assistantIdxs[assistantIdxs.length - keepLastRounds];

	// Thinking blocks: always prune from all rounds except the last one.
	const thinkPruneBeforeIdx =
		assistantIdxs.length <= 1 ? -1 : assistantIdxs[assistantIdxs.length - 1];

	return messages.map((msg, i) => {
		// Strip thinking blocks from old assistant messages.
		if (
			msg.role === "assistant" &&
			thinkPruneBeforeIdx >= 0 &&
			i < thinkPruneBeforeIdx
		) {
			const am = msg as AssistantMessage;
			const filtered = am.content.filter((b) => b.type !== "thinking");
			if (filtered.length !== am.content.length) {
				msg = { ...am, content: filtered };
			}
		}

		// Stub ephemeral tool results from old rounds.
		if (
			msg.role === "toolResult" &&
			toolPruneBeforeIdx >= 0 &&
			i < toolPruneBeforeIdx
		) {
			const tr = msg as ToolResultMessage;
			if (EPHEMERAL_TOOLS.has(tr.toolName)) {
				const alreadyPruned =
					tr.content.length === 1 &&
					tr.content[0].type === "text" &&
					(tr.content[0] as { type: "text"; text: string }).text ===
						PRUNED_STUB;
				if (!alreadyPruned) {
					return { ...tr, content: [{ type: "text", text: PRUNED_STUB }] };
				}
			}
		}

		return msg;
	});
}
