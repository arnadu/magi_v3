import { useState } from "react";
import { type Agent, sendMessage, uploadAttachment } from "../data";
import { LoadError } from "../load-error";

/** Recipient chips, an optional attachment and the message box. */
export function ComposeBar({
	missionId,
	active,
	roster,
	runningAgents,
	label,
	loadError,
	onToggleRecipient,
	onSent,
	draft,
	setDraft,
	file,
	setFile,
}: {
	missionId: string;
	active: string[];
	roster: Agent[];
	runningAgents: Set<string>;
	label: (ids: string[]) => string;
	loadError: string | null;
	onToggleRecipient: (id: string) => void;
	onSent: () => Promise<void>;
	/** Kept by the panel, so a half-written message survives going back to the thread list. */
	draft: string;
	setDraft: (draft: string) => void;
	file: File | null;
	setFile: (file: File | null) => void;
}) {
	const [sending, setSending] = useState(false);
	const [sendError, setSendError] = useState<string | null>(null);

	const send = async () => {
		const body = draft.trim();
		if (active.length === 0 || (!body && !file) || sending) return;
		setSending(true);
		setSendError(null);
		try {
			if (file) {
				await uploadAttachment(missionId, active, file, body);
			} else {
				await sendMessage(missionId, active, body);
			}
			setDraft("");
			setFile(null);
			await onSent();
		} catch (e) {
			// The draft and the file stay in the composer; the failure is shown
			// where the operator is looking (CNV2).
			setSendError(`Send failed: ${(e as Error).message}`);
		} finally {
			setSending(false);
		}
	};

	return (
		<div className="compose">
			<div className="recipients">
				{roster.map((a) => (
					<button
						type="button"
						key={a.id}
						className={`chip${active.includes(a.id) ? " on" : ""}`}
						onClick={() => onToggleRecipient(a.id)}
					>
						{runningAgents.has(a.id) && (
							<span className="busy-dot" title="Currently running" />
						)}
						{a.name}
					</button>
				))}
			</div>
			{file && (
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
				<label className="attach-btn" title="Attach a file">
					📎
					<input
						type="file"
						hidden
						onChange={(e) => setFile(e.target.files?.[0] ?? null)}
					/>
				</label>
				<textarea
					value={draft}
					placeholder={
						active.length ? `Message ${label(active)}…` : "Pick recipients…"
					}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
					}}
				/>
				<button
					type="button"
					className="send"
					onClick={() => void send()}
					disabled={sending || active.length === 0 || (!draft.trim() && !file)}
				>
					Send
				</button>
			</div>
			{sendError && (
				<p className="error-msg" role="alert">
					{sendError}
				</p>
			)}
			<LoadError message={loadError} />
		</div>
	);
}
