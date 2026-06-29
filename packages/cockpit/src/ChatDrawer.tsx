import { useCallback, useEffect, useRef, useState } from "react";
import { fetchThread, sendToAgent, type ThreadMessage } from "./data";

const POLL_MS = 4000;

/**
 * The managerial ↔ conversational pivot: a slide-over thread with one agent.
 * Reads the operator↔agent mailbox thread and sends operator messages (which
 * wake the agent). Opens over the cockpit so the objectives stay visible behind.
 */
export function ChatDrawer({
	missionId,
	agentId,
	onClose,
}: {
	missionId: string;
	agentId: string;
	onClose: () => void;
}) {
	const [messages, setMessages] = useState<ThreadMessage[]>([]);
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const bottomRef = useRef<HTMLDivElement>(null);

	const load = useCallback(async () => {
		try {
			setMessages(await fetchThread(missionId, agentId));
		} catch {
			// keep last good thread on transient failure
		}
	}, [missionId, agentId]);

	useEffect(() => {
		void load();
		const t = setInterval(load, POLL_MS);
		return () => clearInterval(t);
	}, [load]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new messages
	useEffect(() => {
		bottomRef.current?.scrollIntoView({ block: "end" });
	}, [messages.length]);

	const send = async () => {
		const body = draft.trim();
		if (!body || sending) return;
		setSending(true);
		setDraft("");
		try {
			await sendToAgent(missionId, agentId, body);
			await load();
		} finally {
			setSending(false);
		}
	};

	return (
		<>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: scrim closes the drawer */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: scrim is a convenience, drawer has a close button */}
			<div className="scrim" onClick={onClose} />
			<aside className="drawer">
				<div className="drawer-head">
					<span className="drawer-title">{agentId}</span>
					<span className="mut" style={{ fontSize: 11 }}>
						you ↔ agent · replies wake it
					</span>
					<button type="button" className="drawer-x" onClick={onClose}>
						×
					</button>
				</div>
				<div className="conv">
					{messages.length === 0 && (
						<p className="mut">No messages with {agentId} yet. Say hello.</p>
					)}
					{messages.map((m) => (
						<div
							key={m.id}
							className={`bub ${m.from === "user" ? "me" : "them"}`}
						>
							{m.from !== "user" && <div className="bub-from">{m.from}</div>}
							{m.subject && m.subject !== "Message from operator" && (
								<div className="bub-subj">{m.subject}</div>
							)}
							<div className="bub-body">{m.body}</div>
						</div>
					))}
					<div ref={bottomRef} />
				</div>
				<div className="compose">
					<textarea
						value={draft}
						placeholder={`Message ${agentId}…`}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
						}}
					/>
					<button
						type="button"
						className="send"
						onClick={() => void send()}
						disabled={sending || !draft.trim()}
					>
						Send
					</button>
				</div>
			</aside>
		</>
	);
}
