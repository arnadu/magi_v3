import { useState } from "react";
import { InputResizeGrip } from "../InputResizeGrip";
import { useInputResize } from "../use-input-resize";

/** The copilot's message box: Enter sends, Shift+Enter starts a new line; its height is dragged from the bar above it. */
export function CopilotInput({ onSend }: { onSend: (text: string) => void }) {
	const [input, setInput] = useState("");
	const resize = useInputResize("magi-copilot-input-height", 56);

	const send = () => {
		const text = input.trim();
		if (!text) return;
		setInput("");
		onSend(text);
	};

	return (
		<>
			<InputResizeGrip onPointerDown={resize.onGripPointerDown} />
			<div className="copilot-input-area">
				<textarea
					rows={1}
					style={{ height: resize.height }}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							send();
						}
					}}
					placeholder="Message the copilot…"
				/>
				<button type="button" className="btn-primary" onClick={send}>
					Send
				</button>
			</div>
		</>
	);
}
