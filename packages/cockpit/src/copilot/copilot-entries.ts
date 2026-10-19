/**
 * The copilot chat's entries and the pure functions that build them: chat
 * bubbles, tool-activity lines, and confirmation cards for proposed actions.
 */

import type { RawMessage } from "../data";

// Each kind gets its own union member (rather than bundling "user" |
// "copilot" | "system" under one shape) — TypeScript's control-flow
// narrowing for a literal discriminant is reliable per-member but not
// guaranteed for an `||` check against sub-values sharing one member.
export type Entry =
	| { id: number; kind: "user"; text: string }
	| { id: number; kind: "copilot"; text: string }
	| { id: number; kind: "system"; text: string }
	| { id: number; kind: "activity"; text: string; isError: boolean }
	| {
			id: number;
			kind: "action";
			actionId: string;
			type: string;
			label: string;
			payload?: unknown;
			resolved?: { ok: boolean; text: string };
	  };

/** The full payload the operator is confirming — the label alone is not enough to judge an external write. */
export function formatPayload(payload: unknown): string {
	const text = JSON.stringify(payload, null, 2) ?? "";
	return text.length > 4000
		? `${text.slice(0, 4000)}\n… (${text.length - 4000} more characters)`
		: text;
}

export function fmtTokens(n: number): string {
	return n >= 1000 ? `${Math.round(n / 1000)}k tok` : `${n} tok`;
}

/** Most informative single-line summary of a tool call's arguments — mirrors index.html's formatToolArgs. */
export function formatToolArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const val =
		a.command ??
		a.query ??
		a.task ??
		a.missionId ??
		a.id ??
		a.path ??
		a.label ??
		a.url ??
		null;
	if (val == null) return "";
	const s = String(val);
	return s.length > 70 ? `${s.slice(0, 70)}…` : s;
}

/** A confirmation card entry, from an SSE `copilot-action` event or the replay of a persisted pending action. */
export function actionEntry(a: {
	id: string;
	type: string;
	label: string;
	payload?: unknown;
}): Omit<Extract<Entry, { kind: "action" }>, "id"> {
	return {
		kind: "action",
		actionId: a.id,
		type: a.type,
		label: a.label,
		payload: a.payload,
	};
}

/** Marks the card for `result.id` resolved; every other entry is untouched. */
export function withActionResult(
	prev: Entry[],
	result: { id: string; ok: boolean; result?: string; error?: string },
): Entry[] {
	return prev.map((entry) =>
		entry.kind === "action" && entry.actionId === result.id
			? {
					...entry,
					resolved: {
						ok: result.ok,
						text: result.ok ? (result.result ?? "") : (result.error ?? ""),
					},
				}
			: entry,
	);
}

export type NewEntry = Entry extends infer T
	? T extends unknown
		? Omit<T, "id">
		: never
	: never;

/**
 * The activity lines for one message of the copilot's own loop: one per tool
 * call, one per tool result (its PostMessage replies already appear as chat
 * bubbles), or an LLM error. `done` is true when the message ends the turn.
 */
export function loopMessageEntries(msg: RawMessage): {
	entries: NewEntry[];
	done: boolean;
} {
	if (msg.role === "assistant") {
		if (msg.stopReason === "error") {
			return {
				entries: [
					{
						kind: "activity",
						text: `⚠ LLM error: ${(msg.errorMessage as string) || "(no details)"}`,
						isError: true,
					},
				],
				done: true,
			};
		}
		const blocks = (msg.content as Array<Record<string, unknown>>) ?? [];
		return {
			entries: blocks
				.filter((block) => block.type === "toolCall")
				.map((block) => {
					const arg = formatToolArgs(block.arguments);
					return {
						kind: "activity" as const,
						text: arg ? `▶ ${block.name}: ${arg}` : `▶ ${block.name}`,
						isError: false,
					};
				}),
			done: false,
		};
	}
	if (msg.role === "toolResult" && msg.toolName !== "PostMessage") {
		const blocks = (msg.content as Array<Record<string, unknown>>) ?? [];
		const text = blocks
			.filter((b) => b.type === "text")
			.map((b) => b.text as string)
			.join("\n");
		const preview = text.length > 150 ? `${text.slice(0, 150)}…` : text;
		return {
			entries: [
				{
					kind: "activity",
					text: `← ${msg.toolName}: ${preview}`,
					isError: !!msg.isError,
				},
			],
			done: false,
		};
	}
	return { entries: [], done: false };
}
