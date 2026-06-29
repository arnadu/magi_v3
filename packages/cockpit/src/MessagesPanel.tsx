import { useCallback, useEffect, useState } from "react";
import { fetchMessages, markMessagesRead, type UserMessage } from "./data";

const POLL_MS = 5000;

function timeAgo(iso: string): string {
	const d = new Date(iso).getTime();
	const s = Math.max(0, Math.round((Date.now() - d) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return new Date(iso).toLocaleString();
}

export function MessagesPanel({
	missionId,
	onAgentClick,
}: {
	missionId: string | null;
	onAgentClick?: (agentId: string) => void;
}) {
	const [messages, setMessages] = useState<UserMessage[]>([]);
	const [loaded, setLoaded] = useState(false);

	const load = useCallback(async () => {
		if (!missionId) return;
		try {
			setMessages(await fetchMessages(missionId));
			setLoaded(true);
		} catch {
			// keep last good data on transient failure
		}
	}, [missionId]);

	useEffect(() => {
		void load();
		const t = setInterval(load, POLL_MS);
		return () => clearInterval(t);
	}, [load]);

	const markRead = useCallback(
		async (id: string) => {
			if (!missionId) return;
			setMessages((ms) =>
				ms.map((m) => (m.id === id ? { ...m, read: true } : m)),
			);
			await markMessagesRead(missionId, [id]);
		},
		[missionId],
	);

	if (!missionId) {
		return (
			<div className="panel">
				<h2 className="sec">Messages</h2>
				<p className="mut">Select a live mission to see its messages.</p>
			</div>
		);
	}

	const unread = messages.filter((m) => !m.read).length;
	return (
		<div className="panel">
			<h2 className="sec">
				Messages to you{unread > 0 ? ` · ${unread} unread` : ""}
			</h2>
			{loaded && messages.length === 0 && (
				<p className="mut">No messages yet.</p>
			)}
			{messages.map((m) => (
				<button
					type="button"
					key={m.id}
					className={`msg ${m.read ? "" : "unread"}`}
					onClick={() => {
						if (!m.read) markRead(m.id);
						onAgentClick?.(m.from);
					}}
					title={`Open chat with ${m.from}`}
				>
					<div className="msg-head">
						{!m.read && <span className="msg-dot" />}
						<span className="msg-from">{m.from}</span>
						<span className="msg-subj">{m.subject}</span>
						<span className="msg-time">{timeAgo(m.timestamp)}</span>
					</div>
					<div className="msg-body">{m.body}</div>
				</button>
			))}
		</div>
	);
}
