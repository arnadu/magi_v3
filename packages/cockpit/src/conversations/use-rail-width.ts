import { useState } from "react";

const MIN_W = 300;
const MAX_W = 760;
const DEFAULT_W = 380;
const STORAGE_KEY = "magi-rail-width";

/** The conversations rail's width: dragged by its right edge, remembered per browser. */
export function useRailWidth() {
	const [width, setWidth] = useState(
		() => Number(localStorage.getItem(STORAGE_KEY)) || DEFAULT_W,
	);
	// Pointer Events (not mouse-only) so this also works with touch input
	// (iPad/tablet) — a single event model covers mouse, touch, and pen.
	const startResize = (e: React.PointerEvent) => {
		e.preventDefault();
		let last = width;
		const onMove = (ev: PointerEvent) => {
			// Rail is the left column; its right edge is at x = width.
			last = Math.min(MAX_W, Math.max(MIN_W, ev.clientX));
			setWidth(last);
		};
		const onUp = () => {
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onUp);
			localStorage.setItem(STORAGE_KEY, String(last));
		};
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", onUp);
	};

	return { width, startResize };
}
