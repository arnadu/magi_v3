/**
 * A tool that keeps failing the same way. A model that has explained a failure
 * to itself ("a known platform bug") reads every later identical failure as
 * confirmation and stops looking at its own arguments: the control-plane
 * copilot sent PostMessage's recipients in the wrong shape for nine days,
 * blaming an unrelated issue. Each repeat after the second gets a note telling
 * it to look again, and the loop reports the count so a mission can raise it.
 */
import type { Message, ToolResultMessage } from "@mariozechner/pi-ai";

/** The failure count from which the note is added to the result. */
export const REPEATED_FAILURE_THRESHOLD = 3;

const NOTE_MARKER = "\n\n[platform] ";

function errorText(result: ToolResultMessage): string {
	const text = result.content
		.map((c) => (c.type === "text" ? c.text : ""))
		.join("");
	const i = text.indexOf(NOTE_MARKER);
	return i === -1 ? text : text.slice(0, i);
}

/**
 * How many times in a row `result`'s tool has now failed with this same error,
 * counting `result` (not yet in `history`): earlier results of other tools are
 * skipped, the first different result of this tool ends the run. 0 when
 * `result` is not an error.
 */
export function consecutiveIdenticalFailures(
	history: readonly Message[],
	result: ToolResultMessage,
): number {
	if (!result.isError) return 0;
	const text = errorText(result);
	let count = 1;
	for (let i = history.length - 1; i >= 0; i--) {
		const m = history[i];
		if (m.role !== "toolResult" || m.toolName !== result.toolName) continue;
		if (!m.isError || errorText(m) !== text) break;
		count++;
	}
	return count;
}

/** `result` with the note appended when it is a repeat at or past the threshold. */
export function withRepeatNote(
	result: ToolResultMessage,
	count: number,
): ToolResultMessage {
	if (count < REPEATED_FAILURE_THRESHOLD) return result;
	return {
		...result,
		content: [
			...result.content,
			{
				type: "text",
				text: `${NOTE_MARKER}${result.toolName} has now failed ${count} times in a row with this same error. Read the error again and compare your arguments with the tool's parameters: an explanation you gave earlier for this failure may be wrong. Do not record it as a known bug without new evidence.`,
			},
		],
	};
}
