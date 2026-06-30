import { useEffect, useState } from "react";
import { ConversationsPanel } from "./ConversationsPanel";
import {
	AuthError,
	fetchMissions,
	fetchObjectives,
	type MissionSummary,
} from "./data";
import { ObjectivesPanel } from "./ObjectivesPanel";
import { SAMPLE_TREE } from "./sample";
import type { FoldedTree } from "./types";

/** How often the cockpit re-fetches a live mission's objectives. */
const POLL_MS = 4000;

type View =
	| { kind: "loading" }
	| {
			kind: "ready";
			tree: FoldedTree;
			mission: string | null;
			demo: boolean;
			updatedAt: number;
	  }
	| { kind: "picker"; missions: MissionSummary[] }
	| { kind: "auth" }
	| { kind: "error"; message: string };

function useView(): View {
	const [view, setView] = useState<View>({ kind: "loading" });

	useEffect(() => {
		const mission = new URLSearchParams(window.location.search).get("mission");
		let cancelled = false;

		if (mission) {
			// Live mission: load once, then poll. Transient poll failures keep the
			// last good data (don't flip a working view to error); only the INITIAL
			// load surfaces auth/error.
			let succeeded = false;
			const load = async () => {
				try {
					const tree = await fetchObjectives(mission);
					succeeded = true;
					if (!cancelled)
						setView({
							kind: "ready",
							tree,
							mission,
							demo: false,
							updatedAt: Date.now(),
						});
				} catch (e) {
					if (cancelled || succeeded) return;
					if (e instanceof AuthError) setView({ kind: "auth" });
					else setView({ kind: "error", message: (e as Error).message });
				}
			};
			void load();
			const timer = setInterval(load, POLL_MS);
			return () => {
				cancelled = true;
				clearInterval(timer);
			};
		}

		// No mission selected — offer a picker, or fall back to demo data.
		(async () => {
			try {
				const missions = await fetchMissions();
				if (cancelled) return;
				setView(
					missions.length > 0
						? { kind: "picker", missions }
						: {
								kind: "ready",
								tree: SAMPLE_TREE,
								mission: null,
								demo: true,
								updatedAt: Date.now(),
							},
				);
			} catch {
				if (!cancelled)
					setView({
						kind: "ready",
						tree: SAMPLE_TREE,
						mission: null,
						demo: true,
						updatedAt: Date.now(),
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
	const [openAgent, setOpenAgent] = useState<string | null>(null);

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

	const updated = new Date(view.updatedAt).toLocaleTimeString();
	return (
		<div className="app">
			<Header
				subtitle={
					view.demo
						? "demo data — append ?mission=<id> for a live mission"
						: `● live · updated ${updated}`
				}
				tree={view.tree}
			/>
			<div className="cols">
				<ConversationsPanel
					missionId={view.mission}
					openAgent={openAgent}
					onOpened={() => setOpenAgent(null)}
				/>
				<main className="col-main">
					<ObjectivesPanel tree={view.tree} onAgentClick={setOpenAgent} />
				</main>
			</div>
		</div>
	);
}
