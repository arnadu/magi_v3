import { useEffect, useState } from "react";
import { ConversationsPanel } from "./ConversationsPanel";
import {
	AuthError,
	fetchMissions,
	fetchObjectives,
	type MissionSummary,
} from "./data";
import { FilesPanel } from "./FilesPanel";
import { ObjectivesPanel } from "./ObjectivesPanel";
import { SAMPLE_TREE } from "./sample";
import { TracePanel } from "./TracePanel";
import { TranscriptsPanel } from "./TranscriptsPanel";
import type { FoldedTree } from "./types";

type MainTab = "objectives" | "files" | "transcripts" | "trace";

/** A "inspect turn →" deep link from Files into Transcripts. */
interface TurnJump {
	agent: string;
	turn: number;
}

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
			// Live mission: load once, then poll. Transient (network) poll
			// failures keep the last good data (don't flip a working view to
			// error) — but a session expiring mid-session is not transient: every
			// subsequent poll will keep 401ing identically, so an AuthError always
			// surfaces regardless of whether an earlier poll succeeded. Without
			// this, the cockpit silently kept showing stale data forever past the
			// session's ~1h lifetime, with no indication anything was wrong —
			// the panels look like they've stopped receiving updates.
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
					if (cancelled) return;
					if (e instanceof AuthError) {
						setView({ kind: "auth" });
						return;
					}
					if (succeeded) return;
					setView({ kind: "error", message: (e as Error).message });
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

/**
 * Which agents are currently dispatched, live — via the mission's own SSE
 * stream (monitor-server.ts's `agent-status` event), proxied same-origin
 * through the control plane at /missions/:id/events. This is the same
 * stream and event the legacy dashboard (agent-runtime-worker/public/app.js)
 * already consumes successfully through the identical proxy route — no new
 * backend surface, just a consumer the cockpit never had.
 */
function useRunningAgents(missionId: string | null): Set<string> {
	const [running, setRunning] = useState<Set<string>>(new Set());
	useEffect(() => {
		setRunning(new Set());
		if (!missionId) return;
		// withCredentials: the magi_session cookie carries auth, same as every
		// fetch() call in data.ts — EventSource doesn't send cookies by default.
		const es = new EventSource(
			`/missions/${encodeURIComponent(missionId)}/events`,
			{ withCredentials: true },
		);
		es.addEventListener("agent-status", (e) => {
			try {
				const d = JSON.parse((e as MessageEvent).data) as {
					running?: string[];
				};
				setRunning(new Set(d.running ?? []));
			} catch {
				// Malformed event — ignore rather than crash the whole cockpit.
			}
		});
		// No manual reconnect logic: the browser's native EventSource already
		// retries automatically on a dropped connection.
		return () => es.close();
	}, [missionId]);
	return running;
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
	const runningAgents = useRunningAgents(
		view.kind === "ready" ? view.mission : null,
	);
	const [openAgent, setOpenAgent] = useState<string | null>(null);
	const [mainTab, setMainTab] = useState<MainTab>("objectives");
	const [turnJump, setTurnJump] = useState<TurnJump | null>(null);

	const inspectTurn = (agent: string, turn: number) => {
		setMainTab("transcripts");
		setTurnJump({ agent, turn });
	};

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
					runningAgents={runningAgents}
				/>
				<main className="col-main">
					<nav className="tabs">
						<button
							type="button"
							className={`tab ${mainTab === "objectives" ? "on" : ""}`}
							onClick={() => setMainTab("objectives")}
						>
							Objectives
						</button>
						<button
							type="button"
							className={`tab ${mainTab === "files" ? "on" : ""}`}
							onClick={() => setMainTab("files")}
						>
							Files
						</button>
						<button
							type="button"
							className={`tab ${mainTab === "transcripts" ? "on" : ""}`}
							onClick={() => setMainTab("transcripts")}
						>
							Transcripts
						</button>
						<button
							type="button"
							className={`tab ${mainTab === "trace" ? "on" : ""}`}
							onClick={() => setMainTab("trace")}
						>
							Trace
						</button>
					</nav>
					<div className="tab-body">
						{mainTab === "objectives" && (
							<ObjectivesPanel
								tree={view.tree}
								missionId={view.mission}
								onAgentClick={setOpenAgent}
							/>
						)}
						{mainTab === "files" && (
							<FilesPanel
								missionId={view.mission}
								onInspectTurn={inspectTurn}
							/>
						)}
						{mainTab === "transcripts" && (
							<TranscriptsPanel
								missionId={view.mission}
								jumpTo={turnJump}
								onJumped={() => setTurnJump(null)}
								runningAgents={runningAgents}
							/>
						)}
						{mainTab === "trace" && (
							<TracePanel
								missionId={view.mission}
								onInspectTurn={inspectTurn}
							/>
						)}
					</div>
				</main>
			</div>
		</div>
	);
}
