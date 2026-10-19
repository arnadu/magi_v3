import { useEffect, useRef, useState } from "react";
import {
	type CopilotSettings,
	fetchCopilotHistory,
	fetchCopilotPendingActions,
	fetchCopilotSettings,
	fetchCopilotUsage,
	type RawMessage,
} from "../data";
import {
	actionEntry,
	type Entry,
	loopMessageEntries,
	type NewEntry,
	withActionResult,
} from "./copilot-entries";

let nextEntryId = 0;

export interface CopilotUsageTotals {
	calls: number;
	inputTokens: number;
	costUsd: number;
}

const data = <T>(e: Event) => JSON.parse((e as MessageEvent).data) as T;

/**
 * The copilot chat's state: the history and pending cards loaded once, then
 * the live SSE stream (messages, proposed actions and their results, errors,
 * usage, and the copilot's own tool activity).
 */
export function useCopilotStream() {
	const [entries, setEntries] = useState<Entry[]>([]);
	const [thinking, setThinking] = useState(false);
	const [usage, setUsage] = useState<CopilotUsageTotals | null>(null);
	const [settings, setSettings] = useState<CopilotSettings | null>(null);
	const messagesRef = useRef<HTMLDivElement | null>(null);

	const push = (entry: NewEntry) =>
		setEntries((prev) => [...prev, { ...entry, id: nextEntryId++ } as Entry]);
	const scrollBottom = () =>
		requestAnimationFrame(() => {
			const el = messagesRef.current;
			if (el) el.scrollTop = el.scrollHeight;
		});
	const resolve = (actionId: string, resolved: { ok: boolean; text: string }) =>
		setEntries((prev) =>
			prev.map((entry) =>
				entry.kind === "action" && entry.actionId === actionId
					? { ...entry, resolved }
					: entry,
			),
		);

	// biome-ignore lint/correctness/useExhaustiveDependencies: connect once on mount; push/scrollBottom only call stable state setters
	useEffect(() => {
		let cancelled = false;
		void loadInitialChat().then((initial) => {
			if (cancelled) return;
			// Anything the stream delivered while this loaded stays after it.
			setEntries((live) => [...initial.entries, ...live]);
			if (initial.usage) setUsage(initial.usage);
			if (initial.settings) setSettings(initial.settings);
			scrollBottom();
		});

		const es = new EventSource("/api/copilot/events", {
			withCredentials: true,
		});
		const turnEnded = (entry?: NewEntry) => {
			if (entry) push(entry);
			setThinking(false);
			scrollBottom();
		};
		es.addEventListener("copilot-msg", (e) =>
			turnEnded({
				kind: "copilot",
				text: data<{ body?: string }>(e).body ?? "",
			}),
		);
		es.addEventListener("copilot-action", (e) =>
			turnEnded(
				actionEntry(
					data<{ id: string; type: string; label: string; payload?: unknown }>(
						e,
					),
				),
			),
		);
		es.addEventListener("copilot-action-result", (e) => {
			setEntries((prev) =>
				withActionResult(
					prev,
					data<{ id: string; ok: boolean; result?: string; error?: string }>(e),
				),
			);
			scrollBottom();
		});
		es.addEventListener("copilot-error", (e) =>
			turnEnded({
				kind: "activity",
				text: `⚠ Error: ${data<{ errorMessage?: string }>(e).errorMessage}`,
				isError: true,
			}),
		);
		es.addEventListener("copilot-usage", (e) =>
			setUsage(data<CopilotUsageTotals>(e)),
		);
		es.addEventListener("copilot-loop-msg", (e) => {
			setThinking(true);
			const { entries: lines, done } = loopMessageEntries(data<RawMessage>(e));
			for (const line of lines) push(line);
			if (done) setThinking(false);
			scrollBottom();
		});
		es.onerror = () => setThinking(false);
		return () => {
			cancelled = true;
			es.close();
		};
	}, []);

	return {
		entries,
		thinking,
		setThinking,
		usage,
		settings,
		setSettings,
		messagesRef,
		push,
		scrollBottom,
		resolve,
	};
}

/**
 * The chat as it stood before this page loaded: past messages, then any
 * cards proposed earlier (or before a control-plane restart) and still
 * unconfirmed. A failed read leaves that part empty rather than the panel.
 */
async function loadInitialChat(): Promise<{
	entries: Entry[];
	usage: CopilotUsageTotals | null;
	settings: CopilotSettings | null;
}> {
	const [history, usage, settings, pendingCards] = await Promise.all([
		fetchCopilotHistory().catch(() => []),
		fetchCopilotUsage().catch(() => null),
		fetchCopilotSettings().catch(() => null),
		fetchCopilotPendingActions().catch(() => []),
	]);
	const fresh = (e: NewEntry): Entry => ({ ...e, id: nextEntryId++ }) as Entry;
	const entries: Entry[] = history.map((h) =>
		fresh({ kind: h.role === "user" ? "user" : "copilot", text: h.body }),
	);
	if (entries.length > 0) {
		entries.push(
			fresh({ kind: "system", text: "─── earlier messages above ───" }),
		);
	}
	for (const card of pendingCards) entries.push(fresh(actionEntry(card)));
	return { entries, usage, settings };
}
