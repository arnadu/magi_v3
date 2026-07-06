import { useEffect, useState } from "react";
import {
	type AgentMissionStats,
	fetchAgents,
	fetchCostSeries,
	fetchInteractions,
	fetchMissionStats,
	type Interaction,
	type TurnCost,
} from "./data";

const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
const fmtCompact = (n: number) =>
	n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);

// Sequential blue ramp (dataviz skill palette.md) — snap a 0..1 magnitude
// ratio to the nearest defined step. Exactly-zero is handled by the caller
// (rendered as neutral surface, not the palest ramp step) so "no data" never
// looks like "a very small value".
const SEQ_STEPS = [
	"var(--seq-100)",
	"var(--seq-200)",
	"var(--seq-300)",
	"var(--seq-400)",
	"var(--seq-500)",
	"var(--seq-600)",
	"var(--seq-700)",
];
// A label sat inside a colored fill must pick its color by the fill's
// luminance to stay legible (marks-and-anatomy.md) — the top ramp steps are
// dark enough that fixed dark text would be illegible on them.
const DARK_TEXT_FROM_STEP = 4; // --seq-500 and darker get white text
function seqColor(ratio: number): { bg: string; fg: string } {
	const i = Math.min(
		SEQ_STEPS.length - 1,
		Math.round(ratio * (SEQ_STEPS.length - 1)),
	);
	return {
		bg: SEQ_STEPS[i],
		fg: i >= DARK_TEXT_FROM_STEP ? "#fff" : "var(--txt)",
	};
}

function StatTile({ label, value }: { label: string; value: string }) {
	return (
		<div className="stat-tile">
			<div className="stat-label">{label}</div>
			<div className="stat-value">{value}</div>
		</div>
	);
}

// Categorical palette (dataviz skill palette.md), fixed order — one color per
// agent, assigned by first appearance so it stays stable as data streams in.
const CAT_COLORS = [
	"var(--cat-1)",
	"var(--cat-2)",
	"var(--cat-3)",
	"var(--cat-4)",
	"var(--cat-5)",
	"var(--cat-6)",
	"var(--cat-7)",
	"var(--cat-8)",
];

const CHART_W = 760;
const CHART_H = 280;
const PAD_L = 56;
const PAD_R = 16;
const PAD_T = 16;
const PAD_B = 28;

/**
 * Cumulative cost per agent, over real wall-clock time (the mission's original
 * mocked Trace chart — experimental/cockpit-mock.html's renderTrace). Multiple
 * agents are "distinct series to tell apart", which the dataviz skill maps to
 * categorical color (not the sequential ramp used for the bars/heatmap below,
 * which are single-hue magnitude comparisons — a different job). Step-after
 * lines: cost is genuinely a series of discrete jumps at turn completion, not
 * a continuous accrual, so interpolating between sparse points would misstate
 * the shape.
 */
function CostTimeline({
	agents,
	series,
}: {
	agents: string[];
	series: TurnCost[];
}) {
	const [tableView, setTableView] = useState(false);

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

	const times = series.map((t) => new Date(t.completedAt).getTime());
	const minT = Math.min(...times);
	const maxT = Math.max(...times, minT + 1); // avoid a zero-width scale
	const sx = (t: number) =>
		PAD_L + ((t - minT) / (maxT - minT)) * (CHART_W - PAD_L - PAD_R);

	type Pt = { t: number; cum: number; turn?: TurnCost };
	const perAgent = new Map<string, Pt[]>();
	let maxCum = 0;
	for (const agentId of agents) {
		const turns = series
			.filter((t) => t.agentId === agentId)
			.sort(
				(a, b) =>
					new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime(),
			);
		if (turns.length === 0) continue;
		const pts: Pt[] = [{ t: minT, cum: 0 }];
		let cum = 0;
		for (const turn of turns) {
			const t = new Date(turn.completedAt).getTime();
			pts.push({ t, cum }); // flat up to just before this turn lands
			cum += turn.costUsd;
			pts.push({ t, cum, turn }); // step up
		}
		pts.push({ t: maxT, cum }); // hold to the right edge
		perAgent.set(agentId, pts);
		maxCum = Math.max(maxCum, cum);
	}
	maxCum = Math.max(maxCum, 1e-9);
	const sy = (v: number) =>
		CHART_H - PAD_B - (v / maxCum) * (CHART_H - PAD_T - PAD_B);

	const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxCum);
	const xTicks = [0, 0.5, 1].map((f) => minT + f * (maxT - minT));
	const fmtTick = (ts: number) => new Date(ts).toLocaleDateString();

	return (
		<div className="trace-card">
			<div className="trace-card-head">
				<h3 className="trace-card-title">Cumulative cost over time</h3>
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
						</tr>
					</thead>
					<tbody>
						{series.map((t) => (
							<tr key={`${t.agentId}-${t.turnNumber}`}>
								<th scope="row">{t.agentId}</th>
								<td>{t.turnNumber}</td>
								<td>{new Date(t.completedAt).toLocaleString()}</td>
								<td>{fmtUsd(t.costUsd)}</td>
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
						viewBox={`0 0 ${CHART_W} ${CHART_H}`}
						className="trace-svg"
						role="img"
						aria-label="Cumulative cost per agent over time"
					>
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
						{xTicks.map((t) => (
							<text
								key={t}
								x={sx(t)}
								y={CHART_H - PAD_B + 16}
								className="chart-axis"
								textAnchor="middle"
							>
								{fmtTick(t)}
							</text>
						))}
						<line
							x1={PAD_L}
							x2={PAD_L}
							y1={PAD_T}
							y2={CHART_H - PAD_B}
							className="chart-axis-line"
						/>
						<line
							x1={PAD_L}
							x2={CHART_W - PAD_R}
							y1={CHART_H - PAD_B}
							y2={CHART_H - PAD_B}
							className="chart-axis-line"
						/>
						{[...perAgent.entries()].map(([agentId, pts]) => (
							<g key={agentId}>
								<polyline
									fill="none"
									stroke={colorOf(agentId)}
									strokeWidth={2}
									points={pts.map((p) => `${sx(p.t)},${sy(p.cum)}`).join(" ")}
								/>
								{pts
									.filter(
										(p): p is Pt & { turn: TurnCost } => p.turn !== undefined,
									)
									.map((p) => (
										<circle
											key={p.turn.turnNumber}
											cx={sx(p.t)}
											cy={sy(p.cum)}
											r={4}
											fill={colorOf(agentId)}
											stroke="var(--panel)"
											strokeWidth={2}
										>
											<title>
												{`${agentId} · turn ${p.turn.turnNumber} · ${fmtUsd(p.turn.costUsd)} (cumulative ${fmtUsd(p.cum)}) · ${new Date(p.turn.completedAt).toLocaleString()}`}
											</title>
										</circle>
									))}
							</g>
						))}
					</svg>
				</>
			)}
		</div>
	);
}

function CostBars({ stats }: { stats: AgentMissionStats[] }) {
	const [tableView, setTableView] = useState(false);
	const sorted = [...stats].sort(
		(a, b) => b.lifetimeCostUsd - a.lifetimeCostUsd,
	);
	const max = Math.max(1e-9, ...sorted.map((s) => s.lifetimeCostUsd));

	return (
		<div className="trace-card">
			<div className="trace-card-head">
				<h3 className="trace-card-title">Cost by agent</h3>
				<button
					type="button"
					className="rail-btn"
					onClick={() => setTableView((v) => !v)}
				>
					{tableView ? "Chart view" : "Table view"}
				</button>
			</div>
			{sorted.length === 0 ? (
				<p className="mut">No agent activity yet.</p>
			) : tableView ? (
				<table className="trace-table">
					<thead>
						<tr>
							<th scope="col">Agent</th>
							<th scope="col">Cost</th>
							<th scope="col">Turns</th>
							<th scope="col">LLM calls</th>
						</tr>
					</thead>
					<tbody>
						{sorted.map((s) => (
							<tr key={s.agentId}>
								<th scope="row">{s.agentId}</th>
								<td>{fmtUsd(s.lifetimeCostUsd)}</td>
								<td>{s.lifetimeTurnCount}</td>
								<td>{s.lifetimeLlmCallCount}</td>
							</tr>
						))}
					</tbody>
				</table>
			) : (
				<div className="tr-bars">
					{sorted.map((s) => (
						<div className="tr-bar-row" key={s.agentId}>
							<span className="tr-bar-label">{s.agentId}</span>
							<div className="tr-bar-track">
								<div
									className="tr-bar-fill"
									style={{ width: `${(s.lifetimeCostUsd / max) * 100}%` }}
									title={`${s.agentId}: ${fmtUsd(s.lifetimeCostUsd)} · ${s.lifetimeTurnCount} turns · ${s.lifetimeLlmCallCount} calls`}
								/>
							</div>
							<span className="tr-bar-value">{fmtUsd(s.lifetimeCostUsd)}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function InteractionHeatmap({
	agents,
	interactions,
}: {
	agents: string[];
	interactions: Interaction[];
}) {
	const countOf = new Map<string, number>();
	for (const i of interactions) countOf.set(`${i.from}\u0001${i.to}`, i.count);
	const max = Math.max(1, ...interactions.map((i) => i.count));

	if (agents.length === 0) {
		return (
			<div className="trace-card">
				<h3 className="trace-card-title">Agent interactions</h3>
				<p className="mut">No agents yet.</p>
			</div>
		);
	}

	return (
		<div className="trace-card">
			<h3 className="trace-card-title">Agent interactions</h3>
			<p className="mut trace-card-sub">
				Messages sent, row → column. Darker = more messages.
			</p>
			<div className="tr-heatmap-wrap">
				<table className="tr-heatmap">
					<thead>
						<tr>
							<th scope="col" />
							{agents.map((a) => (
								<th scope="col" key={a}>
									{a}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{agents.map((from) => (
							<tr key={from}>
								<th scope="row">{from}</th>
								{agents.map((to) => {
									const count = countOf.get(`${from}\u0001${to}`) ?? 0;
									const c = count > 0 ? seqColor(count / max) : null;
									return (
										<td
											key={to}
											style={c ? { background: c.bg, color: c.fg } : undefined}
											title={`${from} → ${to}: ${count} message${count === 1 ? "" : "s"}`}
										>
											{count > 0 ? fmtCompact(count) : ""}
										</td>
									);
								})}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

export function TracePanel({ missionId }: { missionId: string | null }) {
	const [agents, setAgents] = useState<string[]>([]);
	const [stats, setStats] = useState<AgentMissionStats[] | null>(null);
	const [interactions, setInteractions] = useState<Interaction[] | null>(null);
	const [costSeries, setCostSeries] = useState<TurnCost[] | null>(null);

	useEffect(() => {
		if (!missionId) return;
		fetchAgents(missionId).then(
			(as) => setAgents(as.map((a) => a.id)),
			() => setAgents([]),
		);
		fetchMissionStats(missionId).then(setStats, () => setStats([]));
		fetchInteractions(missionId).then(setInteractions, () =>
			setInteractions([]),
		);
		fetchCostSeries(missionId).then(setCostSeries, () => setCostSeries([]));
	}, [missionId]);

	if (!missionId)
		return <p className="mut">Select a live mission to see its trace.</p>;
	if (stats === null || interactions === null || costSeries === null)
		return <p className="mut">Loading…</p>;

	const totalCost = stats.reduce((a, s) => a + s.lifetimeCostUsd, 0);
	const totalTurns = stats.reduce((a, s) => a + s.lifetimeTurnCount, 0);
	const totalCalls = stats.reduce((a, s) => a + s.lifetimeLlmCallCount, 0);

	// Agent-to-agent interactions only (excludes "user"/copilot channels,
	// already visible in the Conversations rail) — the novel signal here is
	// coordination between mission agents.
	const agentInteractions = interactions.filter(
		(i) => agents.includes(i.from) && agents.includes(i.to),
	);

	return (
		<div className="trace">
			<div className="stat-row">
				<StatTile label="Mission cost" value={fmtUsd(totalCost)} />
				<StatTile label="Turns" value={String(totalTurns)} />
				<StatTile label="LLM calls" value={String(totalCalls)} />
			</div>
			<CostTimeline agents={agents} series={costSeries} />
			<CostBars stats={stats} />
			<InteractionHeatmap agents={agents} interactions={agentInteractions} />
		</div>
	);
}
