import { useState } from "react";
import type { AgentMissionStats } from "../data";
import { fmtUsd } from "./trace-geometry";

export function CostBars({ stats }: { stats: AgentMissionStats[] }) {
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
