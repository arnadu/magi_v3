import { useCallback, useEffect, useRef, useState } from "react";
import {
	type Agent,
	COPILOT_ID,
	type ConvMessage,
	fetchAgents,
	fetchConversations,
	fetchCopilotHistory,
	markMessagesRead,
	sendMessage,
	sendToCopilot,
	uploadAttachment,
} from "./data";
import { Markdown } from "./Markdown";

const POLL_MS = 5000;
const MIN_W = 300;
const MAX_W = 760;
const DEFAULT_W = 380;

function timeAgo(iso: string): string {
	const d = new Date(iso).getTime();
	const s = Math.max(0, Math.round((Date.now() - d) / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.round(s / 60)}m`;
	if (s < 86400) return `${Math.round(s / 3600)}h`;
	return new Date(iso).toLocaleDateString();
}

const keyOf = (parts: string[]) => [...new Set(parts)].sort().join("|");
const threadKeyOfMsg = (m: ConvMessage) => keyOf([m.from, ...m.to]);
const threadKeyForRecipients = (recipients: string[]) =>
	keyOf(["user", ...recipients]);

interface Thread {
	key: string;
	participants: string[]; // excludes "user"
	messages: ConvMessage[];
	last: ConvMessage;
	unread: number;
}

function buildThreads(msgs: ConvMessage[]): Thread[] {
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
 * The permanent comms container in the cockpit rail. Shows the operator's
 * conversations (threads needing attention float up) and, when a thread is
 * picked, the conversation + a multi-recipient compose bar with file attach.
 * No slide-over: picking a thread swaps the rail body; "← All" returns to the
 * list. The rail is the left column and width-resizable (drag its right edge).
 */
export function ConversationsPanel({
	missionId,
	openAgent,
	onOpened,
}: {
	missionId: string | null;
	openAgent: string | null;
	onOpened: () => void;
}) {
	const [conversations, setConversations] = useState<ConvMessage[]>([]);
	const [agents, setAgents] = useState<Agent[]>([]);
	// null = thread list; string[] = recipients of the open/composed thread (excl. user).
	const [active, setActive] = useState<string[] | null>(null);
	const [draft, setDraft] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [sending, setSending] = useState(false);
	const [width, setWidth] = useState(
		() => Number(localStorage.getItem("magi-rail-width")) || DEFAULT_W,
	);
	const bottomRef = useRef<HTMLDivElement>(null);

	const load = useCallback(async () => {
		if (!missionId) return;
		// Mission messages + the cross-mission copilot thread, folded together.
		const [mission, copilot] = await Promise.all([
			fetchConversations(missionId).catch(() => null),
			fetchCopilotHistory().catch(() => null),
		]);
		if (!mission && !copilot) return; // keep last good data
		setConversations([...(mission ?? []), ...(copilot ?? [])]);
	}, [missionId]);

	useEffect(() => {
		void load();
		const t = setInterval(load, POLL_MS);
		return () => clearInterval(t);
	}, [load]);

	useEffect(() => {
		if (!missionId) return;
		fetchAgents(missionId).then(setAgents, () => setAgents([]));
	}, [missionId]);

	// The copilot is always an available recipient, listed first and distinct.
	const roster: Agent[] = [{ id: COPILOT_ID, name: "Copilot" }, ...agents];
	const agentName = useCallback(
		(id: string) =>
			id === COPILOT_ID
				? "Copilot"
				: (agents.find((a) => a.id === id)?.name ?? id),
		[agents],
	);
	const label = useCallback(
		(ids: string[]) => ids.map(agentName).join(", ") || "(system)",
		[agentName],
	);

	const threads = buildThreads(conversations);
	const activeThread = active
		? (threads.find((t) => t.key === threadKeyForRecipients(active)) ?? null)
		: null;

	const markThreadRead = useCallback(
		async (t: Thread) => {
			if (!missionId) return;
			const ids = t.messages
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

	const openThread = useCallback(
		(t: Thread) => {
			setActive(t.participants);
			void markThreadRead(t);
		},
		[markThreadRead],
	);

	// An agent clicked elsewhere in the cockpit → open the 1:1 thread. Runs only
	// when the openAgent signal changes; the other refs are intentionally excluded.
	// biome-ignore lint/correctness/useExhaustiveDependencies: open on signal change only
	useEffect(() => {
		if (!openAgent) return;
		setActive([openAgent]);
		const t = threads.find(
			(x) => x.key === threadKeyForRecipients([openAgent]),
		);
		if (t) void markThreadRead(t);
		onOpened();
	}, [openAgent]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new messages
	useEffect(() => {
		bottomRef.current?.scrollIntoView({ block: "end" });
	}, [activeThread?.messages.length, active]);

	// The copilot is its own system (separate mailbox, no uploads), so it can't
	// share a thread with mission agents — selecting it is mutually exclusive.
	const toggleRecipient = (id: string) =>
		setActive((prev) => {
			const cur = prev ?? [];
			if (id === COPILOT_ID)
				return cur.includes(COPILOT_ID) ? [] : [COPILOT_ID];
			const base = cur.filter((x) => x !== COPILOT_ID);
			return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
		});

	const toCopilot = (active ?? []).includes(COPILOT_ID);

	const send = async () => {
		const body = draft.trim();
		const to = active ?? [];
		if (!missionId || to.length === 0 || (!body && !file) || sending) return;
		setSending(true);
		try {
			if (toCopilot) {
				await sendToCopilot(body); // copilot has no upload pipeline
			} else if (file) {
				await uploadAttachment(missionId, to, file, body);
			} else {
				await sendMessage(missionId, to, body);
			}
			setDraft("");
			setFile(null);
			await load();
		} finally {
			setSending(false);
		}
	};

	const startResize = (e: React.MouseEvent) => {
		e.preventDefault();
		let last = width;
		const onMove = (ev: MouseEvent) => {
			// Rail is the left column; its right edge is at x = width.
			last = Math.min(MAX_W, Math.max(MIN_W, ev.clientX));
			setWidth(last);
		};
		const onUp = () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
			localStorage.setItem("magi-rail-width", String(last));
		};
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	};

	return (
		<aside className="col-rail" style={{ width }}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: drag-to-resize handle */}
			<div
				className="rail-resize"
				onMouseDown={startResize}
				title="Drag to resize"
			/>
			<div className="rail-head">
				{active === null ? (
					<>
						<h2 className="sec">Conversations</h2>
						{missionId && (
							<button
								type="button"
								className="rail-btn"
								onClick={() => {
									setActive([]);
									setDraft("");
									setFile(null);
								}}
							>
								＋ New
							</button>
						)}
					</>
				) : (
					<>
						<button
							type="button"
							className="rail-btn"
							onClick={() => setActive(null)}
						>
							← All
						</button>
						<span className="rail-title">
							{active.length ? label(active) : "New message"}
						</span>
					</>
				)}
			</div>

			{!missionId && (
				<p className="mut rail-pad">
					Select a live mission to see its messages.
				</p>
			)}

			{missionId && active === null && (
				<div className="thread-list">
					{threads.length === 0 && (
						<p className="mut rail-pad">No messages yet.</p>
					)}
					{threads.map((t) => (
						<button
							type="button"
							key={t.key}
							className={`thread-row${t.unread > 0 ? " unread" : ""}${
								t.participants.includes(COPILOT_ID) ? " copilot" : ""
							}`}
							onClick={() => openThread(t)}
						>
							<span className="tr-dot" />
							<span className="tr-who">{label(t.participants)}</span>
							<span className="tr-time">{timeAgo(t.last.timestamp)}</span>
							<span className="tr-snip">
								{t.last.from === "user" ? "You: " : ""}
								{t.last.body}
							</span>
						</button>
					))}
				</div>
			)}

			{missionId && active !== null && (
				<>
					<div className="conv">
						{(activeThread?.messages.length ?? 0) === 0 && (
							<p className="mut">
								{active.length
									? "No messages yet — say hello."
									: "Pick one or more recipients below."}
							</p>
						)}
						{activeThread?.messages.map((m) => (
							<div
								key={m.id}
								className={`bub ${
									m.from === "user"
										? "me"
										: m.from === COPILOT_ID
											? "them copilot"
											: "them"
								}`}
							>
								{m.from !== "user" && (
									<div className="bub-from">{agentName(m.from)}</div>
								)}
								{m.subject && m.subject !== "Message from operator" && (
									<div className="bub-subj">{m.subject}</div>
								)}
								<Markdown text={m.body} className="bub-body" />
							</div>
						))}
						<div ref={bottomRef} />
					</div>

					<div className="compose">
						<div className="recipients">
							{roster.map((a) => (
								<button
									type="button"
									key={a.id}
									className={`chip${active.includes(a.id) ? " on" : ""}${
										a.id === COPILOT_ID ? " copilot" : ""
									}`}
									onClick={() => toggleRecipient(a.id)}
								>
									{a.name}
								</button>
							))}
						</div>
						{!toCopilot && file && (
							<div className="attach-row">
								📎 {file.name}
								<button
									type="button"
									className="attach-x"
									onClick={() => setFile(null)}
								>
									×
								</button>
							</div>
						)}
						<div className="compose-input">
							{!toCopilot && (
								<label className="attach-btn" title="Attach a file">
									📎
									<input
										type="file"
										hidden
										onChange={(e) => setFile(e.target.files?.[0] ?? null)}
									/>
								</label>
							)}
							<textarea
								value={draft}
								placeholder={
									active.length
										? `Message ${label(active)}…`
										: "Pick recipients…"
								}
								onChange={(e) => setDraft(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
										void send();
								}}
							/>
							<button
								type="button"
								className="send"
								onClick={() => void send()}
								disabled={
									sending ||
									active.length === 0 ||
									(!draft.trim() && (toCopilot || !file))
								}
							>
								Send
							</button>
						</div>
					</div>
				</>
			)}
		</aside>
	);
}
