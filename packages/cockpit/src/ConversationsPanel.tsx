import { useEffect, useRef, useState } from "react";
import { ComposeBar } from "./conversations/ComposeBar";
import { ConversationView } from "./conversations/ConversationView";
import { ThreadList } from "./conversations/ThreadList";
import {
	buildThreads,
	messagesWithin,
	threadsWithin,
} from "./conversations/threads";
import { useConversations } from "./conversations/use-conversations";
import { useRailWidth } from "./conversations/use-rail-width";

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
	runningAgents,
}: {
	missionId: string | null;
	openAgent: string | null;
	onOpened: () => void;
	/** Agent ids currently dispatched, live — for a busy indicator on chips. */
	runningAgents: Set<string>;
}) {
	const { conversations, agents, agentName, load, markRead, loadError } =
		useConversations(missionId);
	// null = thread list; string[] = recipients of the open/composed thread (excl. user).
	const [active, setActive] = useState<string[] | null>(null);
	const [draft, setDraft] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const { width, startResize } = useRailWidth();
	const bottomRef = useRef<HTMLDivElement>(null);
	const label = (ids: string[]) => ids.map(agentName).join(", ") || "(system)";
	const threads = buildThreads(conversations);
	const activeMessages = active ? messagesWithin(threads, active) : [];

	// An agent clicked elsewhere in the cockpit → open the 1:1 thread. Runs only
	// when the openAgent signal changes; the other refs are intentionally excluded.
	// biome-ignore lint/correctness/useExhaustiveDependencies: open on signal change only
	useEffect(() => {
		if (!openAgent) return;
		setActive([openAgent]);
		onOpened();
	}, [openAgent]);

	// Mark whatever is now visible as read whenever the selection changes —
	// every path that sets `active` (a thread row, an open from elsewhere,
	// toggling recipient chips) is covered in one place.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-mark only when the selection itself changes, not on every conversations poll tick
	useEffect(() => {
		if (!active || active.length === 0) return;
		void markRead(threadsWithin(threads, active).flatMap((t) => t.messages));
	}, [active, markRead]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new messages
	useEffect(() => {
		bottomRef.current?.scrollIntoView({ block: "end" });
	}, [activeMessages.length, active]);

	const toggleRecipient = (id: string) =>
		setActive((prev) => {
			const cur = prev ?? [];
			return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
		});

	return (
		<aside className="col-rail" style={{ width }}>
			<div
				className="rail-resize"
				onPointerDown={startResize}
				title="Drag to resize"
			/>
			<RailHeader
				active={active}
				canCompose={missionId !== null}
				label={label}
				onNew={() => {
					setActive([]);
					setDraft("");
					setFile(null);
				}}
				onBack={() => setActive(null)}
			/>

			{!missionId && (
				<p className="mut rail-pad">
					Select a live mission to see its messages.
				</p>
			)}

			{missionId && active === null && (
				<ThreadList
					threads={threads}
					label={label}
					onOpen={(t) => setActive(t.participants)}
				/>
			)}

			{missionId && active !== null && (
				<>
					<ConversationView
						messages={activeMessages}
						hasRecipients={active.length > 0}
						missionId={missionId}
						agentName={agentName}
						bottomRef={bottomRef}
					/>
					<ComposeBar
						missionId={missionId}
						active={active}
						roster={agents}
						runningAgents={runningAgents}
						label={label}
						loadError={loadError}
						onToggleRecipient={toggleRecipient}
						onSent={load}
						draft={draft}
						setDraft={setDraft}
						file={file}
						setFile={setFile}
					/>
				</>
			)}
		</aside>
	);
}

function RailHeader({
	active,
	canCompose,
	label,
	onNew,
	onBack,
}: {
	active: string[] | null;
	canCompose: boolean;
	label: (ids: string[]) => string;
	onNew: () => void;
	onBack: () => void;
}) {
	return (
		<div className="rail-head">
			{active === null ? (
				<>
					<h2 className="sec">Conversations</h2>
					{canCompose && (
						<button type="button" className="rail-btn" onClick={onNew}>
							＋ New
						</button>
					)}
				</>
			) : (
				<>
					<button type="button" className="rail-btn" onClick={onBack}>
						← All
					</button>
					<span className="rail-title">
						{active.length ? label(active) : "New message"}
					</span>
				</>
			)}
		</div>
	);
}
