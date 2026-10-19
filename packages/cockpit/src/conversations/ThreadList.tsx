import { type Thread, timeAgo } from "./threads";

export function ThreadList({
	threads,
	label,
	onOpen,
}: {
	threads: Thread[];
	label: (ids: string[]) => string;
	onOpen: (t: Thread) => void;
}) {
	return (
		<div className="thread-list">
			{threads.length === 0 && <p className="mut rail-pad">No messages yet.</p>}
			{threads.map((t) => (
				<button
					type="button"
					key={t.key}
					className={`thread-row${t.unread > 0 ? " unread" : ""}`}
					onClick={() => onOpen(t)}
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
	);
}
