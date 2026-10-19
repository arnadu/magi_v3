import type { KeyboardEvent } from "react";

// Keyboard-activation counterpart to a chart mark's onClick — Enter/Space
// fire the same jump, so a clickable SVG shape (role="button") is reachable
// without a mouse, not just visually indicated as interactive.
export function inspectKeyHandler(
	onInspectTurn: (agent: string, turn: number) => void,
	agent: string,
	turn: number,
) {
	return (e: KeyboardEvent) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			onInspectTurn(agent, turn);
		}
	};
}
