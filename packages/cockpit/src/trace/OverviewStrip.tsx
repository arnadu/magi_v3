import type { TurnCost } from "../data";
import {
	CHART_W,
	OVERVIEW_AXIS_Y,
	OVERVIEW_BOTTOM,
	OVERVIEW_H,
	OVERVIEW_TOP,
	PAD_L,
	PAD_R,
} from "./trace-geometry";

/** The full-range strip under the chart: density ticks, the current brush, and the drag surface. */
export function OverviewStrip({
	series,
	colorOf,
	sxOv,
	fullMinT,
	fullMaxT,
	brush,
	onDragStart,
	fmtTick,
}: {
	series: TurnCost[];
	colorOf: (agentId: string) => string;
	sxOv: (t: number) => number;
	fullMinT: number;
	fullMaxT: number;
	brush: [number, number] | null;
	onDragStart: (clientX: number) => void;
	fmtTick: (ts: number) => string;
}) {
	// Overview density ticks — one per turn completion (the granularity
	// costSeries actually gives us; per-LLM-call would need an llmCallLog
	// fetch this panel doesn't otherwise make).
	const overviewTicks = series.map((t) => ({
		t: new Date(t.completedAt).getTime(),
		color: colorOf(t.agentId),
	}));
	return (
		<>
			<rect
				x={PAD_L}
				y={OVERVIEW_TOP}
				width={CHART_W - PAD_L - PAD_R}
				height={OVERVIEW_H}
				className="trace-overview-bg"
			/>
			{overviewTicks.map((tk, i) => (
				<line
					// biome-ignore lint/suspicious/noArrayIndexKey: ticks have no stable id
					key={i}
					x1={sxOv(tk.t)}
					x2={sxOv(tk.t)}
					y1={OVERVIEW_TOP + 2}
					y2={OVERVIEW_BOTTOM - 2}
					stroke={tk.color}
					strokeWidth={1.5}
					opacity={0.65}
				/>
			))}
			{brush && (
				<rect
					x={brush[0]}
					y={OVERVIEW_TOP}
					width={Math.max(1, brush[1] - brush[0])}
					height={OVERVIEW_H}
					className="trace-brush"
				/>
			)}
			{/* Pointer (mouse/touch/pen) drag-to-zoom surface — not the sole
			    path to anything: every mark above is itself a role="button"
			    jump target, and "Reset zoom" already undoes zoom state from
			    the keyboard. Not tabIndex'd, so it never enters the tab order. */}
			<rect
				x={PAD_L}
				y={OVERVIEW_TOP}
				width={CHART_W - PAD_L - PAD_R}
				height={OVERVIEW_H}
				className="trace-overview-hit"
				onPointerDown={(e) => onDragStart(e.clientX)}
			>
				<title>Drag to zoom · click to reset</title>
			</rect>
			<text
				x={PAD_L}
				y={OVERVIEW_AXIS_Y}
				className="chart-axis"
				textAnchor="start"
			>
				{fmtTick(fullMinT)}
			</text>
			<text
				x={CHART_W - PAD_R}
				y={OVERVIEW_AXIS_Y}
				className="chart-axis"
				textAnchor="end"
			>
				{fmtTick(fullMaxT)}
			</text>
		</>
	);
}
