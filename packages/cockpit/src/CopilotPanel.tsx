import { useState } from "react";
import { CopilotEntryView } from "./copilot/CopilotEntryView";
import { CopilotModelPicker } from "./copilot/CopilotModelPicker";
import { fmtTokens } from "./copilot/copilot-entries";
import { useCopilotStream } from "./copilot/use-copilot-stream";
import {
	confirmCopilotAction,
	dismissCopilotAction,
	sendCopilotMessage,
} from "./data";

/**
 * The control-plane copilot's chat panel, docked on the right: messages,
 * tool activity, confirmation cards for proposed actions, and the model
 * picker. Resizable; the width is remembered per browser.
 */

const WIDTH_STORAGE_KEY = "magi-copilot-panel-width";
const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 280;
const MAX_WIDTH = 720;

function loadStoredWidth(): number {
	const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
	const n = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(n)
		? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n))
		: DEFAULT_WIDTH;
}

export function CopilotPanel() {
	const [width, setWidth] = useState(loadStoredWidth);
	const [input, setInput] = useState("");
	const chat = useCopilotStream();

	// Matches ConversationsPanel's startResize (same closure-over-`last`
	// pattern, direct position rather than delta tracking — no stale-closure
	// risk either way). The rail derives width straight from clientX because
	// it's pinned to the viewport's left edge; this panel is pinned to the
	// right edge instead, so width is the distance from clientX to the right
	// edge of the viewport. Pointer Events (not mouse-only) so this also works
	// with touch input (iPad/tablet) — a single event model covers mouse,
	// touch, and pen.
	const startResize = (e: React.PointerEvent) => {
		e.preventDefault();
		let last = width;
		const onMove = (ev: PointerEvent) => {
			last = Math.min(
				MAX_WIDTH,
				Math.max(MIN_WIDTH, window.innerWidth - ev.clientX),
			);
			setWidth(last);
		};
		const onUp = () => {
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onUp);
			localStorage.setItem(WIDTH_STORAGE_KEY, String(last));
		};
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", onUp);
	};

	async function handleSend() {
		const text = input.trim();
		if (!text) return;
		setInput("");
		chat.push({ kind: "user", text });
		chat.setThinking(true);
		chat.scrollBottom();
		try {
			await sendCopilotMessage(text);
		} catch (e) {
			chat.setThinking(false);
			chat.push({ kind: "system", text: (e as Error).message });
		}
	}

	async function handleConfirm(actionId: string) {
		const { result, error } = await confirmCopilotAction(actionId);
		chat.resolve(actionId, { ok: !error, text: error ?? result ?? "" });
	}

	async function handleDismiss(actionId: string) {
		await dismissCopilotAction(actionId);
		chat.resolve(actionId, { ok: true, text: "dismissed" });
	}

	const { usage } = chat;
	return (
		<div className="copilot-panel" style={{ width }}>
			<div
				className="copilot-resize"
				onPointerDown={startResize}
				title="Drag to resize"
			/>
			<div className="copilot-header">
				<h3>MAGI Copilot</h3>
				<div className="copilot-header-right">
					{usage && usage.calls > 0 && (
						<span className="mut copilot-cost">
							{usage.calls} calls · {fmtTokens(usage.inputTokens)} · $
							{usage.costUsd.toFixed(4)}
						</span>
					)}
					<CopilotModelPicker
						settings={chat.settings}
						onSaved={chat.setSettings}
					/>
				</div>
			</div>
			<div className="copilot-messages" ref={chat.messagesRef}>
				{chat.entries.length === 0 && (
					<div className="cop-bubble system-msg">
						Copilot is ready. Ask a question or describe a task.
					</div>
				)}
				{chat.entries.map((entry) => (
					<CopilotEntryView
						key={entry.id}
						entry={entry}
						onConfirm={handleConfirm}
						onDismiss={handleDismiss}
					/>
				))}
			</div>
			{chat.thinking && (
				<div className="copilot-thinking">Copilot is thinking…</div>
			)}
			<div className="copilot-input-area">
				<textarea
					rows={1}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							void handleSend();
						}
					}}
					placeholder="Message the copilot…"
				/>
				<button type="button" className="btn-primary" onClick={handleSend}>
					Send
				</button>
			</div>
		</div>
	);
}
