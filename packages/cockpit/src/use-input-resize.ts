import { useState } from "react";

/**
 * A chat input's height, set by dragging the grip above it. Touch and mouse
 * alike (pointer events): iPad Safari has no resize corner on a textarea.
 * The height is remembered per browser under `storageKey`.
 */

export const MIN_INPUT_HEIGHT = 40;

/** The share of the window a chat input may take at most. */
const MAX_SHARE = 0.6;

/** The input's new height after the grip moved `dy` pixels (up is negative), within its bounds. */
export function nextInputHeight(
	startHeight: number,
	dy: number,
	maxHeight: number,
): number {
	return Math.round(
		Math.min(maxHeight, Math.max(MIN_INPUT_HEIGHT, startHeight - dy)),
	);
}

function maxHeight(): number {
	return Math.max(MIN_INPUT_HEIGHT, window.innerHeight * MAX_SHARE);
}

function loadHeight(storageKey: string, fallback: number): number {
	try {
		const n = Number(localStorage.getItem(storageKey));
		return n > 0 ? nextInputHeight(n, 0, maxHeight()) : fallback;
	} catch {
		return fallback;
	}
}

export function useInputResize(storageKey: string, defaultHeight: number) {
	const [height, setHeight] = useState(() =>
		loadHeight(storageKey, defaultHeight),
	);

	const onGripPointerDown = (e: React.PointerEvent) => {
		e.preventDefault();
		const startY = e.clientY;
		const startHeight = height;
		const max = maxHeight();
		let last = startHeight;
		const onMove = (ev: PointerEvent) => {
			last = nextInputHeight(startHeight, ev.clientY - startY, max);
			setHeight(last);
		};
		const onUp = () => {
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onUp);
			document.removeEventListener("pointercancel", onUp);
			try {
				localStorage.setItem(storageKey, String(last));
			} catch {
				// Not remembered in this browser (private mode, blocked storage).
			}
		};
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", onUp);
		document.addEventListener("pointercancel", onUp);
	};

	return { height, onGripPointerDown };
}
