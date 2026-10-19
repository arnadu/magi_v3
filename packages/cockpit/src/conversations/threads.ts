/** Grouping the operator's mailbox into conversation threads (pure). */

import type { ConvMessage } from "../data";

export function timeAgo(iso: string): string {
	const d = new Date(iso).getTime();
	const s = Math.max(0, Math.round((Date.now() - d) / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.round(s / 60)}m`;
	if (s < 86400) return `${Math.round(s / 3600)}h`;
	return new Date(iso).toLocaleDateString();
}

const keyOf = (parts: string[]) => [...new Set(parts)].sort().join("|");
const threadKeyOfMsg = (m: ConvMessage) => keyOf([m.from, ...m.to]);

export interface Thread {
	key: string;
	/** Excludes "user". */
	participants: string[];
	messages: ConvMessage[];
	last: ConvMessage;
	unread: number;
}

export function buildThreads(msgs: ConvMessage[]): Thread[] {
	const map = new Map<string, ConvMessage[]>();
	for (const m of msgs) {
		const k = threadKeyOfMsg(m);
		const list = map.get(k);
		if (list) list.push(m);
		else map.set(k, [m]);
	}
	const threads: Thread[] = [];
	for (const [key, list] of map) {
		list.sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp));
		const participants = key.split("|").filter((p) => p !== "user");
		if (participants.length === 0) continue; // user-only noise
		const unread = list.filter((m) => !m.read && m.from !== "user").length;
		const last = list[list.length - 1];
		threads.push({ key, participants, messages: list, last, unread });
	}
	// Threads needing attention (unread) float to the top, then by recency.
	threads.sort(
		(a, b) =>
			(b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0) ||
			+new Date(b.last.timestamp) - +new Date(a.last.timestamp),
	);
	return threads;
}

/**
 * Every thread whose participants all lie within the selection. An agent
 * replies only `to: ["user"]`, never to the multi-recipient set it was part
 * of, so a message sent to [analyst, mission-copilot] and each agent's 1:1
 * reply land in three different threads; an exact-key match showed only the
 * outgoing message.
 */
export function threadsWithin(
	threads: Thread[],
	selection: string[],
): Thread[] {
	return threads.filter(
		(t) =>
			t.participants.length > 0 &&
			t.participants.every((p) => selection.includes(p)),
	);
}

/** The messages of those threads, oldest first. */
export function messagesWithin(
	threads: Thread[],
	selection: string[],
): ConvMessage[] {
	return threadsWithin(threads, selection)
		.flatMap((t) => t.messages)
		.sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp));
}
