import type { Interaction } from "../data";
import { fmtCompact, seqColor } from "./trace-geometry";

export function InteractionHeatmap({
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
