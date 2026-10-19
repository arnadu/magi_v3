import type { RefObject } from "react";
import type { ConvMessage } from "../data";
import { Markdown } from "../Markdown";

export function ConversationView({
	messages,
	hasRecipients,
	missionId,
	agentName,
	bottomRef,
}: {
	messages: ConvMessage[];
	hasRecipients: boolean;
	missionId: string;
	agentName: (id: string) => string;
	bottomRef: RefObject<HTMLDivElement>;
}) {
	return (
		<div className="conv">
			{messages.length === 0 && (
				<p className="mut">
					{hasRecipients
						? "No messages yet — say hello."
						: "Pick one or more recipients below."}
				</p>
			)}
			{messages.map((m) => (
				<div key={m.id} className={`bub ${m.from === "user" ? "me" : "them"}`}>
					{m.from !== "user" && (
						<div className="bub-from">{agentName(m.from)}</div>
					)}
					{m.subject && m.subject !== "Message from operator" && (
						<div className="bub-subj">{m.subject}</div>
					)}
					<Markdown text={m.body} className="bub-body" missionId={missionId} />
				</div>
			))}
			<div ref={bottomRef} />
		</div>
	);
}
