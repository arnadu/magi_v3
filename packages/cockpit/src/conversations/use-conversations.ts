import { useCallback, useState } from "react";
import {
	type Agent,
	type ConvMessage,
	fetchAgents,
	fetchConversations,
	markMessagesRead,
} from "../data";
import { useLoadError } from "../load-error";
import { useVisiblePoll } from "../use-visible-poll";

const POLL_MS = 5000;

/** The operator's mailbox and the mission roster, both polled while the tab is visible. */
export function useConversations(missionId: string | null) {
	const [conversations, setConversations] = useState<ConvMessage[]>([]);
	const [agents, setAgents] = useState<Agent[]>([]);
	const { loadError, failed, clearLoadError } = useLoadError();

	const load = useCallback(async () => {
		if (!missionId) return;
		const mission = await fetchConversations(missionId).catch(() => null);
		if (!mission) return; // keep last good data
		setConversations(mission);
	}, [missionId]);
	useVisiblePoll(load, POLL_MS);

	// Poll rather than fetch once: the roster (esp. the in-memory-injected
	// mission-copilot) can be transiently missing right after a daemon crash
	// restart, and a one-shot fetch in that window would keep a stale roster
	// for the rest of the session (github#26).
	const loadAgents = useCallback(() => {
		if (!missionId) return;
		fetchAgents(missionId).then((as) => {
			setAgents(as);
			clearLoadError();
		}, failed("Loading the roster"));
	}, [missionId, failed, clearLoadError]);
	useVisiblePoll(loadAgents, POLL_MS);

	/** Marks the operator-facing unread ones read, locally at once and then on the server. */
	const markRead = useCallback(
		async (msgs: ConvMessage[]) => {
			if (!missionId) return;
			const ids = msgs
				.filter((m) => !m.read && m.from !== "user")
				.map((m) => m.id);
			if (ids.length === 0) return;
			setConversations((cs) =>
				cs.map((m) => (ids.includes(m.id) ? { ...m, read: true } : m)),
			);
			await markMessagesRead(missionId, ids);
		},
		[missionId],
	);

	const agentName = useCallback(
		(id: string) => agents.find((a) => a.id === id)?.name ?? id,
		[agents],
	);
	return { conversations, agents, agentName, load, markRead, loadError };
}
