import { useEffect, useState } from "react";
import {
	AuthError,
	fetchMissions,
	fetchObjectives,
	type MissionSummary,
} from "./data";
import { ObjectivesPanel } from "./ObjectivesPanel";
import { SAMPLE_TREE } from "./sample";
import type { FoldedTree } from "./types";

type View =
	| { kind: "loading" }
	| { kind: "ready"; tree: FoldedTree; mission: string | null; demo: boolean }
	| { kind: "picker"; missions: MissionSummary[] }
	| { kind: "auth" }
	| { kind: "error"; message: string };

function useView(): View {
	const [view, setView] = useState<View>({ kind: "loading" });

	useEffect(() => {
		const mission = new URLSearchParams(window.location.search).get("mission");
		let cancelled = false;

		(async () => {
			if (mission) {
				try {
					const tree = await fetchObjectives(mission);
					if (!cancelled)
						setView({ kind: "ready", tree, mission, demo: false });
				} catch (e) {
					if (cancelled) return;
					if (e instanceof AuthError) setView({ kind: "auth" });
					else setView({ kind: "error", message: (e as Error).message });
				}
				return;
			}
			// No mission selected — offer a picker, or fall back to demo data.
			try {
				const missions = await fetchMissions();
				if (cancelled) return;
				setView(
					missions.length > 0
						? { kind: "picker", missions }
						: { kind: "ready", tree: SAMPLE_TREE, mission: null, demo: true },
				);
			} catch {
				if (!cancelled)
					setView({
						kind: "ready",
						tree: SAMPLE_TREE,
						mission: null,
						demo: true,
					});
			}
		})();

		return () => {
			cancelled = true;
		};
	}, []);

	return view;
}

function Header({ subtitle, tree }: { subtitle: string; tree?: FoldedTree }) {
	const spent = tree ? tree.objectives.reduce((a, o) => a + o.costUsd, 0) : 0;
	const budget = tree
		? tree.objectives.reduce((a, o) => a + o.budgetUsd, 0)
		: 0;
	return (
		<header>
			<h1>
				<span className="dot" /> Mission Cockpit
			</h1>
			{tree && (
				<span className="mut">
					spend <b>{`$${spent.toFixed(2)}`}</b> / ${budget.toFixed(2)}
				</span>
			)}
			<span className="grow" />
			<span className="mut" style={{ fontSize: 11 }}>
				{subtitle}
			</span>
		</header>
	);
}

export function App() {
	const view = useView();

	if (view.kind === "loading") {
		return (
			<div className="app">
				<Header subtitle="loading…" />
				<main>
					<p className="mut">Loading objectives…</p>
				</main>
			</div>
		);
	}

	if (view.kind === "auth") {
		return (
			<div className="app">
				<Header subtitle="not signed in" />
				<main>
					<p className="mut">
						You're not signed in. Open the <a href="/">dashboard</a> to sign in,
						then return here.
					</p>
				</main>
			</div>
		);
	}

	if (view.kind === "error") {
		return (
			<div className="app">
				<Header subtitle="error" />
				<main>
					<p className="mut">Could not load objectives: {view.message}</p>
				</main>
			</div>
		);
	}

	if (view.kind === "picker") {
		return (
			<div className="app">
				<Header subtitle="select a mission" />
				<main>
					<h2 className="sec">Your missions</h2>
					<ul className="missions">
						{view.missions.map((m) => (
							<li key={m.missionId}>
								<a href={`?mission=${encodeURIComponent(m.missionId)}`}>
									{m.name || m.missionId}
								</a>
							</li>
						))}
					</ul>
				</main>
			</div>
		);
	}

	return (
		<div className="app">
			<Header
				subtitle={
					view.demo
						? "demo data — append ?mission=<id> for a live mission"
						: (view.mission ?? "")
				}
				tree={view.tree}
			/>
			<main>
				<ObjectivesPanel tree={view.tree} />
			</main>
		</div>
	);
}
