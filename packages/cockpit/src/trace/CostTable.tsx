import type { TurnCost } from "../data";
import { fmtUsd } from "./trace-geometry";

/** The cost timeline's accessible alternative: one row per completed turn. */
export function CostTable({ series }: { series: TurnCost[] }) {
	return (
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
	);
}
