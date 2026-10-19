import { useState } from "react";
import type { AgentError } from "./app-hooks";
import { sendMessage } from "./data";

/**
 * Shown when an agent's turn stopped on an LLM provider error. Resume (for
 * non-transient errors) mails the agent a nudge to continue from its mental map.
 */
export function AgentErrorBanner({
	error,
	missionId,
	onDismiss,
}: {
	error: AgentError;
	missionId: string;
	onDismiss: () => void;
}) {
	const [resuming, setResuming] = useState(false);
	const short =
		error.errorMessage.length > 120
			? `${error.errorMessage.slice(0, 120)}…`
			: error.errorMessage;

	async function handleResume() {
		setResuming(true);
		try {
			await sendMessage(
				missionId,
				[error.agentId],
				"A technical issue (LLM provider error) interrupted your previous session. The issue has been resolved. Review your mental map to recall where you were, then continue your work.",
				"Resume after technical interruption",
			);
			onDismiss();
		} catch {
			setResuming(false);
		}
	}

	return (
		<div className="agent-error-banner">
			<span className="ae-icon">✗</span>
			<span className="ae-msg">
				Agent {error.agentId} stopped — {short}
			</span>
			<span className="ae-hint mut">
				{error.transient
					? "Transient error (rate limit / overload) — the agent will retry automatically on the next wakeup."
					: "Provider error (credit exhaustion or auth failure) — resolve the issue then click Resume."}
			</span>
			<button type="button" className="rail-btn" onClick={onDismiss}>
				Dismiss
			</button>
			{!error.transient && (
				<button
					type="button"
					className="rail-btn"
					disabled={resuming}
					onClick={handleResume}
				>
					{resuming ? "Sending…" : "Resume"}
				</button>
			)}
		</div>
	);
}
