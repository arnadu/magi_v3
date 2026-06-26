import { ObjectivesPanel } from "./ObjectivesPanel";
import { SAMPLE_TREE } from "./sample";

export function App() {
	const spent = SAMPLE_TREE.objectives.reduce((a, o) => a + o.costUsd, 0);
	const budget = SAMPLE_TREE.objectives.reduce((a, o) => a + o.budgetUsd, 0);
	return (
		<div className="app">
			<header>
				<h1>
					<span className="dot" /> DPO Team — Mission Cockpit
				</h1>
				<span className="mut">
					spend <b>{`$${spent.toFixed(2)}`}</b> / ${budget.toFixed(2)}
				</span>
				<span className="grow" />
				<span className="mut" style={{ fontSize: 11 }}>
					sample data — live wiring next
				</span>
			</header>
			<main>
				<ObjectivesPanel tree={SAMPLE_TREE} />
			</main>
		</div>
	);
}
