import { type Entry, formatPayload } from "./copilot-entries";

/** One line of the copilot chat: a bubble, a tool-activity line, or a confirmation card. */
export function CopilotEntryView({
	entry,
	onConfirm,
	onDismiss,
}: {
	entry: Entry;
	onConfirm: (actionId: string) => void;
	onDismiss: (actionId: string) => void;
}) {
	if (entry.kind === "user" || entry.kind === "copilot") {
		return (
			<div
				className={`cop-bubble from-${entry.kind === "user" ? "user" : "copilot"}`}
			>
				{entry.text}
			</div>
		);
	}
	if (entry.kind === "system") {
		return <div className="cop-bubble system-msg">{entry.text}</div>;
	}
	if (entry.kind === "activity") {
		return (
			<div className={`cop-activity${entry.isError ? " tool-error" : ""}`}>
				{entry.text}
			</div>
		);
	}
	return (
		<div className="cop-action-card">
			<div className="action-label">{entry.label}</div>
			<div className="action-type">type: {entry.type}</div>
			{entry.payload !== undefined && (
				<details className="action-payload">
					<summary>What exactly will be done</summary>
					<pre>{formatPayload(entry.payload)}</pre>
				</details>
			)}
			{entry.resolved ? (
				<div className={`action-result${entry.resolved.ok ? "" : " error"}`}>
					{entry.resolved.ok ? "✓ " : "✗ "}
					{entry.resolved.text}
				</div>
			) : (
				<div className="action-btns">
					<button
						type="button"
						className="btn-primary btn-sm"
						onClick={() => onConfirm(entry.actionId)}
					>
						Confirm
					</button>
					<button
						type="button"
						className="rail-btn btn-sm"
						onClick={() => onDismiss(entry.actionId)}
					>
						Dismiss
					</button>
				</div>
			)}
		</div>
	);
}
