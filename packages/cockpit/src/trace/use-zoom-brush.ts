import { useCallback, useEffect, useRef, useState } from "react";
import {
	CHART_W,
	DRAG_CLICK_THRESHOLD_PX,
	PAD_L,
	PAD_R,
} from "./trace-geometry";

/**
 * Drag-to-zoom on the overview strip. Returns the zoomed time range (null =
 * the full range), the drag in progress (SVG x coordinates) and the handlers.
 * The domain bounds may be degenerate (Infinity) when there is no data; the
 * strip that starts a drag is not rendered then.
 */
export function useZoomBrush(fullMinT: number, fullMaxT: number) {
	// null = showing the mission's full time range. Set by dragging a
	// selection on the overview strip; cleared by "Reset zoom" or a plain
	// click (a drag shorter than DRAG_CLICK_THRESHOLD_PX) on the strip.
	const [zoomDomain, setZoomDomain] = useState<[number, number] | null>(null);
	// Live drag in progress on the overview strip, in SVG x-coordinates.
	const [drag, setDrag] = useState<{ startX: number; curX: number } | null>(
		null,
	);
	const svgRef = useRef<SVGSVGElement>(null);

	const clientXToSvg = useCallback((clientX: number): number => {
		const el = svgRef.current;
		if (!el) return 0;
		const rect = el.getBoundingClientRect();
		if (rect.width === 0) return 0;
		return (clientX - rect.left) * (CHART_W / rect.width);
	}, []);

	const invertOv = useCallback(
		(x: number): number => {
			const t =
				fullMinT +
				((x - PAD_L) / (CHART_W - PAD_L - PAD_R)) * (fullMaxT - fullMinT);
			return Math.min(fullMaxT, Math.max(fullMinT, t));
		},
		[fullMinT, fullMaxT],
	);

	// Window-level listeners while dragging — a drag routinely continues past
	// the overview strip's own bounds, so per-element pointer handlers alone
	// would lose track of the pointer. Pointer Events (not mouse-only) so this
	// also works with touch input (iPad/tablet).
	useEffect(() => {
		if (!drag) return;
		const onMove = (e: PointerEvent) => {
			const x = clientXToSvg(e.clientX);
			setDrag((d) => (d ? { ...d, curX: x } : d));
		};
		const onUp = (e: PointerEvent) => {
			const x = clientXToSvg(e.clientX);
			setDrag((d) => {
				if (!d) return null;
				const x0 = Math.min(d.startX, x);
				const x1 = Math.max(d.startX, x);
				if (x1 - x0 < DRAG_CLICK_THRESHOLD_PX) {
					setZoomDomain(null);
				} else {
					setZoomDomain([invertOv(x0), invertOv(x1)]);
				}
				return null;
			});
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
	}, [drag, clientXToSvg, invertOv]);

	const startDrag = (clientX: number) => {
		const x = clientXToSvg(clientX);
		setDrag({ startX: x, curX: x });
	};
	/** The brush's x range on the overview strip, or null while the full range is shown. */
	const brushRange = (sxOv: (t: number) => number): [number, number] | null => {
		if (drag) {
			return [
				Math.min(drag.startX, drag.curX),
				Math.max(drag.startX, drag.curX),
			];
		}
		return zoomDomain ? [sxOv(zoomDomain[0]), sxOv(zoomDomain[1])] : null;
	};
	return {
		svgRef,
		brushRange,
		zoomDomain,
		resetZoom: () => setZoomDomain(null),
		drag,
		startDrag,
	};
}
