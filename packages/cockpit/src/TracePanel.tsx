import { useEffect, useState } from "react";
import {
	type AgentMissionStats,
	fetchAgents,
	fetchInteractions,
	fetchMissionStats,
	type Interaction,
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
	}, [missionId]);

	if (!missionId)
		return <p className="mut">Select a live mission to see its trace.</p>;
	if (stats === null || interactions === null)
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
			<CostBars stats={stats} />
			<InteractionHeatmap agents={agents} interactions={agentInteractions} />
		</div>
	);
}
