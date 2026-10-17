import { useEffect } from "react";

/**
 * Run `fn` now and every `ms` while the tab is visible. A hidden tab does
 * not poll (a 5 s full re-render of Markdown, mermaid and KaTeX for every
 * bubble in a background tab was pure waste); it refreshes once the moment
 * the tab becomes visible again.
 */
export function useVisiblePoll(fn: () => void, ms: number): void {
	useEffect(() => {
		const tick = () => {
			if (document.visibilityState === "hidden") return;
			fn();
		};
		tick();
		const timer = setInterval(tick, ms);
		const onVisible = () => {
			if (document.visibilityState === "visible") fn();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [fn, ms]);
}
