import { useState } from "react";
import type { MessageEvent, TurnCost } from "../data";
import { CostAxes } from "./CostAxes";
import { CostMarks } from "./CostMarks";
import { CostTable } from "./CostTable";
import { EventLanes } from "./EventLanes";
import { OverviewStrip } from "./OverviewStrip";
import {
	CAT_COLORS,
	CHART_H,
	CHART_W,
	cumulativeCostLines,
	fullTimeDomain,
	LANES_BOTTOM,
	MAIN_AXIS_Y,
	PAD_L,
	PAD_R,
	PLOT_BOTTOM,
	PLOT_TOP,
} from "./trace-geometry";
import { useZoomBrush } from "./use-zoom-brush";

/**
 * Cumulative cost per agent, over real wall-clock time (the mission's original
 * mocked Trace chart — experimental/cockpit-mock.html's renderTrace). Multiple
 * agents are "distinct series to tell apart", which the dataviz skill maps to
 * categorical color (not the sequential ramp used for the bars/heatmap below,
 * which are single-hue magnitude comparisons — a different job). Step-after
 * lines: cost is genuinely a series of discrete jumps at turn completion, not
 * a continuous accrual, so interpolating between sparse points would misstate
 * the shape.
 *
 * Each turn is additionally drawn as a small box spanning [startedAt,
 * completedAt] at the pre-jump cost level, sized by llmCallCount — this is
 * the "bounding box of the calls inside a turn" from the mock's turnDetail(),
 * done without a per-call llmCallLog query: agentTurnStats already carries
 * the turn-level call count.
 *
 * Below the plot, four marker lanes (files written, messages sent, scheduled
 * wakeups, aborted turns) share the same time axis — the mock's per-turn
 * drill-down asked for these signals; agentTurnStats/mailbox already carry
 * them, so no new backend instrumentation was needed to surface them here.
 */
export function CostTimeline({
	agents,
	series,
	messageEvents,
	onInspectTurn,
}: {
	agents: string[];
	series: TurnCost[];
	messageEvents: MessageEvent[];
	onInspectTurn: (agent: string, turn: number) => void;
}) {
	const [tableView, setTableView] = useState(false);
	const fullDomain = fullTimeDomain(series, messageEvents);
	const brush = useZoomBrush(fullDomain[0], fullDomain[1]);

	if (series.length === 0) {
		return (
			<div className="trace-card">
				<h3 className="trace-card-title">Cumulative cost over time</h3>
				<p className="mut">No completed turns yet.</p>
			</div>
		);
	}

	return (
		<div className="trace-card">
			<div className="trace-card-head">
				<h3 className="trace-card-title">Cumulative cost over time</h3>
				{!tableView && brush.zoomDomain && (
					<button type="button" className="rail-btn" onClick={brush.resetZoom}>
						Reset zoom
					</button>
				)}
				<button
					type="button"
					className="rail-btn"
					onClick={() => setTableView((v) => !v)}
				>
					{tableView ? "Chart view" : "Table view"}
				</button>
			</div>
			{tableView ? (
				<CostTable series={series} />
			) : (
				<CostChart
					agents={agents}
					series={series}
					messageEvents={messageEvents}
					fullDomain={fullDomain}
					brush={brush}
					onInspectTurn={onInspectTurn}
				/>
			)}
		</div>
	);
}

function ChartLegend({
	agents,
	colorOf,
}: {
	agents: string[];
	colorOf: (agentId: string) => string;
}) {
	if (agents.length <= 1) return null;
	return (
		<div className="chart-legend">
			{agents.map((a) => (
				<span key={a} className="chart-legend-item">
					<i style={{ background: colorOf(a) }} />
					{a}
				</span>
			))}
		</div>
	);
}

/** The chart itself: scales for the current zoom, then plot, lanes, ticks and the overview strip. */
function CostChart({
	agents,
	series,
	messageEvents,
	fullDomain,
	brush,
	onInspectTurn,
}: {
	agents: string[];
	series: TurnCost[];
	messageEvents: MessageEvent[];
	fullDomain: [number, number];
	brush: ReturnType<typeof useZoomBrush>;
	onInspectTurn: (agent: string, turn: number) => void;
}) {
	const [fullMinT, fullMaxT] = fullDomain;
	const { svgRef, zoomDomain, startDrag } = brush;
	const colorOf = (agentId: string) => {
		const i = agents.indexOf(agentId);
		return CAT_COLORS[i >= 0 ? i % CAT_COLORS.length : 0];
	};

	// The overview strip always spans the full range — its scale never
	// changes, so it stays a stable "map" while the main plot zooms.
	const sxOv = (t: number) =>
		PAD_L +
		((t - fullMinT) / (fullMaxT - fullMinT)) * (CHART_W - PAD_L - PAD_R);

	const [minT, maxT] = zoomDomain ?? [fullMinT, fullMaxT];
	const sx = (t: number) =>
		PAD_L + ((t - minT) / (maxT - minT)) * (CHART_W - PAD_L - PAD_R);

	const { perAgentLine, boxes, maxCum } = cumulativeCostLines(
		agents,
		series,
		[fullMinT, fullMaxT],
		sx,
	);
	const sy = (v: number) =>
		PLOT_BOTTOM - (v / maxCum) * (PLOT_BOTTOM - PLOT_TOP);

	const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxCum);
	const xTicks = [0, 0.5, 1].map((f) => minT + f * (maxT - minT));
	const fmtTick = (ts: number) => new Date(ts).toLocaleDateString();

	return (
		<>
			<ChartLegend agents={agents} colorOf={colorOf} />
			<svg
				ref={svgRef}
				viewBox={`0 0 ${CHART_W} ${CHART_H}`}
				className="trace-svg"
				role="img"
				aria-label="Cumulative cost per agent over time, with turn, file, message, wakeup and anomaly markers. Drag on the strip at the bottom to zoom; click a turn to inspect it."
			>
				<defs>
					<clipPath id="trace-plot-clip">
						<rect
							x={PAD_L}
							y={PLOT_TOP}
							width={CHART_W - PAD_L - PAD_R}
							height={LANES_BOTTOM - PLOT_TOP}
						/>
					</clipPath>
				</defs>
				<CostAxes yTicks={yTicks} sy={sy} />
				<g clipPath="url(#trace-plot-clip)">
					<CostMarks
						perAgentLine={perAgentLine}
						boxes={boxes}
						sx={sx}
						sy={sy}
						colorOf={colorOf}
						onInspectTurn={onInspectTurn}
					/>
					<EventLanes
						agents={agents}
						series={series}
						messageEvents={messageEvents}
						sx={sx}
						colorOf={colorOf}
						onInspectTurn={onInspectTurn}
					/>
				</g>

				{xTicks.map((t) => (
					<text
						key={t}
						x={sx(t)}
						y={MAIN_AXIS_Y}
						className="chart-axis"
						textAnchor="middle"
					>
						{fmtTick(t)}
					</text>
				))}

				<OverviewStrip
					series={series}
					colorOf={colorOf}
					sxOv={sxOv}
					fullMinT={fullMinT}
					fullMaxT={fullMaxT}
					brush={brush.brushRange(sxOv)}
					onDragStart={startDrag}
					fmtTick={fmtTick}
				/>
			</svg>
		</>
	);
}
