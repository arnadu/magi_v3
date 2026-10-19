import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { MessageEvent, TurnCost } from "../data";
import {
	CAT_COLORS,
	CHART_H,
	CHART_W,
	type CostPoint,
	cumulativeCostLines,
	DRAG_CLICK_THRESHOLD_PX,
	fmtCompact,
	fmtUsd,
	fullTimeDomain,
	LANE_DEFS,
	LANE_H,
	LANES_BOTTOM,
	laneY,
	MAIN_AXIS_Y,
	MIN_BOX_WIDTH_PX,
	OVERVIEW_AXIS_Y,
	OVERVIEW_BOTTOM,
	OVERVIEW_H,
	OVERVIEW_TOP,
	PAD_L,
	PAD_R,
	PLOT_BOTTOM,
	PLOT_TOP,
} from "./trace-geometry";

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
// Keyboard-activation counterpart to a chart mark's onClick — Enter/Space
// fire the same jump, so a clickable SVG shape (role="button") is reachable
// without a mouse, not just visually indicated as interactive.
function inspectKeyHandler(
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

	// Domain bounds computed unconditionally (even before we know whether
	// there's any data to chart) so the drag-listener effect below — which
	// must itself be unconditional, before any early return — can depend on
	// a stable invertOv. Degenerate (Infinity) when series/messageEvents are
	// both empty is harmless: the overview strip that would trigger a drag
	// never renders in that case (see the early return below).
	const [fullMinT, fullMaxT] = fullTimeDomain(series, messageEvents);

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

	if (series.length === 0) {
		return (
			<div className="trace-card">
				<h3 className="trace-card-title">Cumulative cost over time</h3>
				<p className="mut">No completed turns yet.</p>
			</div>
		);
	}

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

	// Box height scales with how many LLM calls happened in the turn (min 6,
	// max 22px) — a busy turn reads as a visibly chunkier box than a
	// single-call one, without needing the per-call llmCallLog data.
	const boxHeight = (llmCallCount: number) =>
		Math.min(22, Math.max(6, 5 + llmCallCount * 1.5));

	const fileTurns = series.filter((t) => (t.gitChangedFiles?.length ?? 0) > 0);
	const anomalyTurns = series.filter((t) => t.status === "aborted");
	const wakeupEvents = messageEvents.filter((m) => m.from === "scheduler");
	const agentMessageEvents = messageEvents.filter(
		(m) => m.from !== "scheduler",
	);

	// Overview density ticks — one per turn completion (the granularity
	// costSeries actually gives us; per-LLM-call would need an llmCallLog
	// fetch this panel doesn't otherwise make).
	const overviewTicks = series.map((t) => ({
		t: new Date(t.completedAt).getTime(),
		color: colorOf(t.agentId),
	}));

	const brushX0 = drag
		? Math.min(drag.startX, drag.curX)
		: zoomDomain
			? sxOv(zoomDomain[0])
			: null;
	const brushX1 = drag
		? Math.max(drag.startX, drag.curX)
		: zoomDomain
			? sxOv(zoomDomain[1])
			: null;

	return (
		<div className="trace-card">
			<div className="trace-card-head">
				<h3 className="trace-card-title">Cumulative cost over time</h3>
				{!tableView && zoomDomain && (
					<button
						type="button"
						className="rail-btn"
						onClick={() => setZoomDomain(null)}
					>
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
				<table className="trace-table">
					<thead>
						<tr>
							<th scope="col">Agent</th>
							<th scope="col">Turn</th>
							<th scope="col">Completed</th>
							<th scope="col">Cost</th>
							<th scope="col">LLM calls</th>
							<th scope="col">Status</th>
						</tr>
					</thead>
					<tbody>
						{series.map((t) => (
							<tr key={`${t.agentId}-${t.turnNumber}`}>
								<th scope="row">{t.agentId}</th>
								<td>{t.turnNumber}</td>
								<td>{new Date(t.completedAt).toLocaleString()}</td>
								<td>{fmtUsd(t.costUsd)}</td>
								<td>{t.llmCallCount}</td>
								<td>{t.status}</td>
							</tr>
						))}
					</tbody>
				</table>
			) : (
				<>
					{agents.length > 1 && (
						<div className="chart-legend">
							{agents.map((a) => (
								<span key={a} className="chart-legend-item">
									<i style={{ background: colorOf(a) }} />
									{a}
								</span>
							))}
						</div>
					)}
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
						{yTicks.map((v) => (
							<g key={v}>
								<line
									x1={PAD_L}
									x2={CHART_W - PAD_R}
									y1={sy(v)}
									y2={sy(v)}
									className="chart-grid"
								/>
								<text
									x={PAD_L - 8}
									y={sy(v) + 3}
									className="chart-axis"
									textAnchor="end"
								>
									{fmtUsd(v)}
								</text>
							</g>
						))}
						<line
							x1={PAD_L}
							x2={PAD_L}
							y1={PLOT_TOP}
							y2={PLOT_BOTTOM}
							className="chart-axis-line"
						/>
						<line
							x1={PAD_L}
							x2={CHART_W - PAD_R}
							y1={PLOT_BOTTOM}
							y2={PLOT_BOTTOM}
							className="chart-axis-line"
						/>
						<g clipPath="url(#trace-plot-clip)">
							{[...perAgentLine.entries()].map(([agentId, pts]) => (
								<polyline
									key={agentId}
									fill="none"
									stroke={colorOf(agentId)}
									strokeWidth={2}
									points={pts.map((p) => `${sx(p.t)},${sy(p.cum)}`).join(" ")}
								/>
							))}
							{boxes.map((b) => {
								const h = boxHeight(b.turn.llmCallCount);
								const y = sy(b.cumBefore);
								const aborted = b.turn.status === "aborted";
								const natW = b.x2 - b.x1;
								const w = Math.max(MIN_BOX_WIDTH_PX, natW);
								const x = (b.x1 + b.x2) / 2 - w / 2;
								return (
									// biome-ignore lint/a11y/useSemanticElements: SVG has no <button> equivalent for a shape; role="button" + tabIndex + onKeyDown is the WAI-ARIA-recommended pattern for a clickable non-form SVG element
									<rect
										key={`${b.turn.agentId}-${b.turn.turnNumber}`}
										className="trace-mark"
										x={x}
										y={y - h / 2}
										width={w}
										height={h}
										rx={2}
										fill={colorOf(b.turn.agentId)}
										fillOpacity={0.25}
										stroke={aborted ? "var(--bad)" : colorOf(b.turn.agentId)}
										strokeWidth={aborted ? 1.5 : 1}
										strokeDasharray={aborted ? "3 2" : undefined}
										role="button"
										tabIndex={0}
										onClick={() =>
											onInspectTurn(b.turn.agentId, b.turn.turnNumber)
										}
										onKeyDown={inspectKeyHandler(
											onInspectTurn,
											b.turn.agentId,
											b.turn.turnNumber,
										)}
									>
										<title>
											{`${b.turn.agentId} · turn ${b.turn.turnNumber} · ${b.turn.llmCallCount} LLM call${b.turn.llmCallCount === 1 ? "" : "s"} · peak ctx ${fmtCompact(b.turn.peakContextTokens)} · ${fmtUsd(b.turn.costUsd)}${aborted ? " · ABORTED" : ""} — click to inspect`}
										</title>
									</rect>
								);
							})}
							{[...perAgentLine.entries()].flatMap(([agentId, pts]) =>
								pts
									.filter(
										(p): p is CostPoint & { turn: TurnCost } =>
											p.turn !== undefined,
									)
									.map((p) => (
										// biome-ignore lint/a11y/useSemanticElements: SVG has no <button> equivalent for a shape; see the turn-box rect above
										<circle
											key={`${agentId}-${p.turn.turnNumber}-dot`}
											className="trace-mark"
											cx={sx(p.t)}
											cy={sy(p.cum)}
											r={3}
											fill={colorOf(agentId)}
											stroke="var(--panel)"
											strokeWidth={1.5}
											role="button"
											tabIndex={0}
											onClick={() => onInspectTurn(agentId, p.turn.turnNumber)}
											onKeyDown={inspectKeyHandler(
												onInspectTurn,
												agentId,
												p.turn.turnNumber,
											)}
										>
											<title>
												{`${agentId} · turn ${p.turn.turnNumber} · ${fmtUsd(p.turn.costUsd)} (cumulative ${fmtUsd(p.cum)}) · ${new Date(p.turn.completedAt).toLocaleString()} — click to inspect`}
											</title>
										</circle>
									)),
							)}

							{LANE_DEFS.map((lane) => (
								<g key={lane.key}>
									<text
										x={PAD_L - 8}
										y={laneY(lane.key) + LANE_H / 2 + 3}
										className="chart-axis chart-lane-label"
										textAnchor="end"
									>
										{lane.label}
									</text>
									<line
										x1={PAD_L}
										x2={CHART_W - PAD_R}
										y1={laneY(lane.key) + LANE_H / 2}
										y2={laneY(lane.key) + LANE_H / 2}
										className="chart-grid"
									/>
								</g>
							))}

							{fileTurns.map((t) => (
								// biome-ignore lint/a11y/useSemanticElements: SVG has no <button> equivalent for a shape; see the turn-box rect above
								<circle
									key={`file-${t.agentId}-${t.turnNumber}`}
									className="trace-mark"
									cx={sx(new Date(t.completedAt).getTime())}
									cy={laneY("files") + LANE_H / 2}
									r={3.5}
									fill={colorOf(t.agentId)}
									role="button"
									tabIndex={0}
									onClick={() => onInspectTurn(t.agentId, t.turnNumber)}
									onKeyDown={inspectKeyHandler(
										onInspectTurn,
										t.agentId,
										t.turnNumber,
									)}
								>
									<title>
										{`${t.agentId} · turn ${t.turnNumber} wrote ${t.gitChangedFiles?.length} file${t.gitChangedFiles?.length === 1 ? "" : "s"}: ${t.gitChangedFiles?.map((f) => f.path).join(", ")} — click to inspect`}
									</title>
								</circle>
							))}
							{agentMessageEvents.map((m, i) => (
								<circle
									// biome-ignore lint/suspicious/noArrayIndexKey: messages have no stable id from the API
									key={`msg-${i}`}
									cx={sx(new Date(m.timestamp).getTime())}
									cy={laneY("messages") + LANE_H / 2}
									r={3.5}
									fill={
										agents.includes(m.from) ? colorOf(m.from) : "var(--dim)"
									}
								>
									<title>
										{`${m.from} → ${m.to.join(", ")}: ${m.subject || "(no subject)"} · ${new Date(m.timestamp).toLocaleString()}`}
									</title>
								</circle>
							))}
							{wakeupEvents.map((m, i) => (
								<circle
									// biome-ignore lint/suspicious/noArrayIndexKey: messages have no stable id from the API
									key={`wake-${i}`}
									cx={sx(new Date(m.timestamp).getTime())}
									cy={laneY("wakeups") + LANE_H / 2}
									r={3.5}
									fill="var(--info)"
								>
									<title>
										{`Scheduled wakeup → ${m.to.join(", ")}: ${m.subject || "(no subject)"} · ${new Date(m.timestamp).toLocaleString()}`}
									</title>
								</circle>
							))}
							{anomalyTurns.map((t) => (
								// biome-ignore lint/a11y/useSemanticElements: SVG has no <button> equivalent for a shape; see the turn-box rect above
								<circle
									key={`anomaly-${t.agentId}-${t.turnNumber}`}
									className="trace-mark"
									cx={sx(new Date(t.completedAt).getTime())}
									cy={laneY("anomalies") + LANE_H / 2}
									r={3.5}
									fill="var(--bad)"
									role="button"
									tabIndex={0}
									onClick={() => onInspectTurn(t.agentId, t.turnNumber)}
									onKeyDown={inspectKeyHandler(
										onInspectTurn,
										t.agentId,
										t.turnNumber,
									)}
								>
									<title>
										{`${t.agentId} · turn ${t.turnNumber} aborted · ${new Date(t.completedAt).toLocaleString()} — click to inspect`}
									</title>
								</circle>
							))}
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

						{/* Overview strip — full-range density ticks + draggable brush. */}
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
						{brushX0 !== null && brushX1 !== null && (
							<rect
								x={brushX0}
								y={OVERVIEW_TOP}
								width={Math.max(1, brushX1 - brushX0)}
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
							onPointerDown={(e) => {
								const x = clientXToSvg(e.clientX);
								setDrag({ startX: x, curX: x });
							}}
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
					</svg>
				</>
			)}
		</div>
	);
}
