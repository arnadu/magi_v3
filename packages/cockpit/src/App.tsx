import { useEffect, useState } from "react";
import { type AuthState, subscribeAuth } from "./auth";
import { ConfigPanel } from "./ConfigPanel";
import { ConversationsPanel } from "./ConversationsPanel";
import { CopilotFilesPanel } from "./CopilotFilesPanel";
import { CopilotLimitsPanel } from "./CopilotLimitsPanel";
import { CopilotPanel } from "./CopilotPanel";
import { CopilotTranscriptsPanel } from "./CopilotTranscriptsPanel";
import {
	AuthError,
	fetchMissionName,
	fetchMissionStatus,
	fetchMissions,
	fetchObjectives,
	type MissionStatusValue,
	type MissionSummary,
	resumeMission,
	sendMessage,
	suspendMission,
} from "./data";
import { FilesPanel } from "./FilesPanel";
import { LimitsPanel } from "./LimitsPanel";
import { LoginScreen } from "./LoginScreen";
import { LogPanel } from "./LogPanel";
import { MissionsPanel } from "./MissionsPanel";
import { ObjectivesPanel } from "./ObjectivesPanel";
import { SchedulePanel } from "./SchedulePanel";
import { SAMPLE_TREE } from "./sample";
import { TemplatesPanel } from "./TemplatesPanel";
import { TracePanel } from "./TracePanel";
import { TranscriptsPanel } from "./TranscriptsPanel";
import type { FoldedTree } from "./types";

/** Drives whether the cockpit shows the login screen or the rest of the app. */
function useAuthState(): AuthState {
	const [state, setState] = useState<AuthState>({ status: "loading" });
	useEffect(() => subscribeAuth(setState), []);
	return state;
}

type MainTab =
	| "objectives"
	| "files"
	| "transcripts"
	| "trace"
	| "limits"
	| "schedule"
	| "log"
	| "config";

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

/**
 * refreshKey: bump to force the picker (no ?mission given) to re-fetch — e.g.
 * after MissionsPanel creates/destroys a mission.
 * authStatus: gates the fetch entirely — without this, useView() fired its
 * fetchMissions()/fetchObjectives() call on every mount regardless of auth
 * state, producing a benign-but-noisy 401 before sign-in, and — the real bug —
 * never retried after a *successful* sign-in (view stayed stuck at
 * `{kind:"auth"}` from the pre-sign-in 401 forever, since refreshKey never
 * changes just because auth succeeded). Including authStatus in the deps
 * makes any transition, especially signed-out→signed-in, trigger a fresh
 * fetch.
 */
function useView(refreshKey: number, authStatus: AuthState["status"]): View {
	const [view, setView] = useState<View>({ kind: "loading" });

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a deliberate manual-refetch trigger, not a value read inside the effect
	useEffect(() => {
		if (authStatus !== "signed-in") return;
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
			} catch (e) {
				if (cancelled) return;
				// An expired/missing session must surface the login screen, not
				// silently fall back to demo data — a signed-out operator hitting
				// the bare cockpit URL used to see demo data with no indication
				// anything was wrong (only the ?mission= branch above checked this).
				if (e instanceof AuthError) {
					setView({ kind: "auth" });
					return;
				}
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
	}, [refreshKey, authStatus]);

	return view;
}

interface AgentError {
	agentId: string;
	errorMessage: string;
	transient: boolean;
}

interface MissionStatus {
	running: Set<string>;
	budgetPaused: boolean;
	agentError: AgentError | null;
	dismissAgentError: () => void;
}

/**
 * Which agents are currently dispatched, live, plus the mission's
 * budget-paused state — via the mission's own SSE stream (monitor-server.ts's
 * `agent-status` and `status` events), proxied same-origin through the
 * control plane at /missions/:id/events. `agent-status` is the same stream
 * and event the legacy dashboard (agent-runtime-worker/public/app.js) already
 * consumes through the identical proxy route — no new backend surface, just
 * a consumer the cockpit never had. `status` is pushed on connect and on
 * every budget-cap/pause change (monitor-server.ts), which is reliable for
 * "did the mission just get paused" but does NOT update on ordinary cost
 * accrual (no per-LLM-call SSE push exists) — this is not a live spend
 * ticker, that's what the Limits panel's own fetch is for.
 */
/**
 * How long to wait for any message (a real event, or the server's periodic
 * heartbeat comment — monitor-server.ts's SSE_HEARTBEAT_MS, 20s) before
 * assuming the connection died silently and forcing a reconnect. A silent
 * drop (the WireGuard control→mission path has a documented >60s idle-
 * connection cutoff) never fires EventSource's own onerror, so native
 * reconnect alone can't catch it — this watchdog is the backstop.
 */
const SSE_WATCHDOG_MS = 45_000;

function useMissionStatus(missionId: string | null): MissionStatus {
	const [running, setRunning] = useState<Set<string>>(new Set());
	const [budgetPaused, setBudgetPaused] = useState(false);
	const [agentError, setAgentError] = useState<AgentError | null>(null);
	useEffect(() => {
		setRunning(new Set());
		setBudgetPaused(false);
		setAgentError(null);
		if (!missionId) return;
		const mid = missionId; // narrow once — TS doesn't carry the guard above into the nested connect()

		let es: EventSource;
		let watchdog: ReturnType<typeof setTimeout>;
		let cancelled = false;

		const resetWatchdog = () => {
			clearTimeout(watchdog);
			watchdog = setTimeout(connect, SSE_WATCHDOG_MS);
		};

		function connect() {
			es?.close();
			if (cancelled) return;
			// withCredentials: the magi_session cookie carries auth, same as every
			// fetch() call in data.ts — EventSource doesn't send cookies by default.
			es = new EventSource(`/missions/${encodeURIComponent(mid)}/events`, {
				withCredentials: true,
			});
			es.onopen = resetWatchdog;
			es.onerror = resetWatchdog;
			// Server's periodic keepalive (monitor-server.ts's SSE_HEARTBEAT_MS) —
			// sent as a real event, not a `:`-comment, specifically so it's
			// observable here and can reset the watchdog below.
			es.addEventListener("ping", resetWatchdog);
			es.addEventListener("agent-status", (e) => {
				resetWatchdog();
				try {
					const d = JSON.parse((e as MessageEvent).data) as {
						running?: string[];
					};
					setRunning(new Set(d.running ?? []));
				} catch {
					// Malformed event — ignore rather than crash the whole cockpit.
				}
			});
			es.addEventListener("status", (e) => {
				resetWatchdog();
				try {
					const d = JSON.parse((e as MessageEvent).data) as {
						budgetPaused?: boolean;
					};
					setBudgetPaused(!!d.budgetPaused);
				} catch {
					// Malformed event — ignore rather than crash the whole cockpit.
				}
			});
			// Ported from app.js's showAgentErrorBanner — the daemon already fires
			// this on a provider failure, but neither the cockpit nor (until now)
			// any part of it actually listened for it.
			es.addEventListener("agent-error", (e) => {
				resetWatchdog();
				try {
					const d = JSON.parse((e as MessageEvent).data) as {
						agentId?: string;
						errorMessage?: string;
						transient?: boolean;
					};
					if (d.agentId && d.errorMessage) {
						setAgentError({
							agentId: d.agentId,
							errorMessage: d.errorMessage,
							transient: !!d.transient,
						});
					}
				} catch {
					// Malformed event — ignore rather than crash the whole cockpit.
				}
			});
			resetWatchdog();
		}

		connect();
		return () => {
			cancelled = true;
			clearTimeout(watchdog);
			es?.close();
		};
	}, [missionId]);
	return {
		running,
		budgetPaused,
		agentError,
		dismissAgentError: () => setAgentError(null),
	};
}

/** Suspend/Resume toggle for the mission dashboard header — same action the Missions list already has, without needing to go back there. */
function MissionStatusButton({ missionId }: { missionId: string }) {
	const [status, setStatus] = useState<MissionStatusValue | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		fetchMissionStatus(missionId).then(
			(s) => {
				if (!cancelled) setStatus(s);
			},
			() => {
				if (!cancelled) setStatus(null);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [missionId]);

	async function handleClick() {
		if (status !== "running" && status !== "suspended") return;
		setBusy(true);
		setError(null);
		try {
			if (status === "running") {
				await suspendMission(missionId);
				setStatus("suspended");
			} else {
				await resumeMission(missionId);
				setStatus("running");
			}
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	// Nothing sensible to toggle mid-transition (provisioning/error/destroyed).
	if (status !== "running" && status !== "suspended") return null;

	return (
		<>
			<button
				type="button"
				className="header-status-btn"
				disabled={busy}
				onClick={handleClick}
			>
				{busy ? "…" : status === "running" ? "⏸ Suspend" : "▶ Resume"}
			</button>
			{error && <span className="error-msg header-status-error">{error}</span>}
		</>
	);
}

/** Self-fetches the mission's display name — same pattern as MissionStatusButton. */
function useMissionName(missionId: string | undefined): string | null {
	const [name, setName] = useState<string | null>(null);
	useEffect(() => {
		setName(null);
		if (!missionId) return;
		let cancelled = false;
		fetchMissionName(missionId).then(
			(n) => {
				if (!cancelled) setName(n);
			},
			() => {
				if (!cancelled) setName(null);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [missionId]);
	return name;
}

function Header({
	subtitle,
	tree,
	budgetPaused,
	onBack,
	missionId,
}: {
	subtitle: string;
	tree?: FoldedTree;
	budgetPaused?: boolean;
	/** Shown as a "← Missions" link when set — only the per-mission view has anywhere to go back to. */
	onBack?: () => void;
	/** Shows a Suspend/Resume toggle when set — same lifecycle action the Missions list already has, available without leaving the mission dashboard. */
	missionId?: string;
}) {
	const spent = tree ? tree.objectives.reduce((a, o) => a + o.costUsd, 0) : 0;
	const budget = tree
		? tree.objectives.reduce((a, o) => a + o.budgetUsd, 0)
		: 0;
	const missionName = useMissionName(missionId);
	return (
		<header>
			{onBack && (
				<button type="button" className="header-back-btn" onClick={onBack}>
					← Missions
				</button>
			)}
			<h1>
				<span className="dot" />{" "}
				{missionId
					? `Mission Cockpit — ${missionName ?? missionId}`
					: "MAGI Control Cockpit"}
			</h1>
			{missionId && <MissionStatusButton missionId={missionId} />}
			{tree && (
				<span className="mut">
					spend <b>{`$${spent.toFixed(2)}`}</b> / ${budget.toFixed(2)}
				</span>
			)}
			{budgetPaused && (
				<span className="badge badge-bad" title="See the Limits tab">
					⏸ budget paused
				</span>
			)}
			<span className="grow" />
			<span className="mut" style={{ fontSize: 11 }}>
				{subtitle}
			</span>
		</header>
	);
}

/** Ported from app.js's showAgentErrorBanner/hideAgentErrorBanner (agent-runtime-worker/public/app.js). */
function AgentErrorBanner({
	error,
	missionId,
	onDismiss,
}: {
	error: AgentError;
	missionId: string;
	onDismiss: () => void;
}) {
	const [resuming, setResuming] = useState(false);
	const short =
		error.errorMessage.length > 120
			? `${error.errorMessage.slice(0, 120)}…`
			: error.errorMessage;

	async function handleResume() {
		setResuming(true);
		try {
			await sendMessage(
				missionId,
				[error.agentId],
				"A technical issue (LLM provider error) interrupted your previous session. The issue has been resolved. Review your mental map to recall where you were, then continue your work.",
				"Resume after technical interruption",
			);
			onDismiss();
		} catch {
			setResuming(false);
		}
	}

	return (
		<div className="agent-error-banner">
			<span className="ae-icon">✗</span>
			<span className="ae-msg">
				Agent {error.agentId} stopped — {short}
			</span>
			<span className="ae-hint mut">
				{error.transient
					? "Transient error (rate limit / overload) — the agent will retry automatically on the next wakeup."
					: "Provider error (credit exhaustion or auth failure) — resolve the issue then click Resume."}
			</span>
			<button type="button" className="rail-btn" onClick={onDismiss}>
				Dismiss
			</button>
			{!error.transient && (
				<button
					type="button"
					className="rail-btn"
					disabled={resuming}
					onClick={handleResume}
				>
					{resuming ? "Sending…" : "Resume"}
				</button>
			)}
		</div>
	);
}

function LoadingView() {
	return (
		<div className="app">
			<Header subtitle="loading…" />
			<main>
				<p className="mut">Loading objectives…</p>
			</main>
		</div>
	);
}

export function App() {
	const authState = useAuthState();
	const [refreshKey, setRefreshKey] = useState(0);
	const view = useView(refreshKey, authState.status);
	const {
		running: runningAgents,
		budgetPaused,
		agentError,
		dismissAgentError,
	} = useMissionStatus(view.kind === "ready" ? view.mission : null);
	const [openAgent, setOpenAgent] = useState<string | null>(null);
	const [mainTab, setMainTab] = useState<MainTab>("objectives");
	const [turnJump, setTurnJump] = useState<TurnJump | null>(null);
	const [homeTab, setHomeTab] = useState<"missions" | "templates" | "copilot">(
		"missions",
	);
	const [copilotTab, setCopilotTab] = useState<
		"transcripts" | "files" | "limits"
	>("transcripts");

	const inspectTurn = (agent: string, turn: number) => {
		setMainTab("transcripts");
		setTurnJump({ agent, turn });
	};

	if (authState.status === "loading") {
		return <LoadingView />;
	}

	// Proactive: no session at all. Reactive backstop: view.kind === "auth" is
	// set when a fetch 401s mid-session (cookie expired) even though
	// authState hadn't caught up yet — same login screen either way.
	if (authState.status === "signed-out" || view.kind === "auth") {
		return (
			<LoginScreen
				initialError={
					authState.status === "signed-out" ? authState.error : null
				}
			/>
		);
	}

	// Only meaningful once signed in — useView()'s effect is a no-op while
	// signed out, so view.kind stays "loading" forever in that state (that's
	// fine, it's masked by the signed-out gate above, not this one).
	if (view.kind === "loading") {
		return <LoadingView />;
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
			<div className="app-shell">
				<div className="app">
					<Header subtitle="select a mission" />
					<nav className="home-tabs">
						<button
							type="button"
							className={`home-tab${homeTab === "missions" ? " home-tab-active" : ""}`}
							onClick={() => setHomeTab("missions")}
						>
							Missions
						</button>
						<button
							type="button"
							className={`home-tab${homeTab === "templates" ? " home-tab-active" : ""}`}
							onClick={() => setHomeTab("templates")}
						>
							Templates
						</button>
						<button
							type="button"
							className={`home-tab${homeTab === "copilot" ? " home-tab-active" : ""}`}
							onClick={() => setHomeTab("copilot")}
						>
							Copilot
						</button>
					</nav>
					{homeTab === "missions" ? (
						<MissionsPanel
							missions={view.missions}
							onRefresh={() => setRefreshKey((k) => k + 1)}
							initialTemplateId={new URLSearchParams(
								window.location.search,
							).get("launch")}
						/>
					) : homeTab === "templates" ? (
						<TemplatesPanel
							onLaunch={(templateId) => {
								window.location.search = `?launch=${encodeURIComponent(templateId)}`;
							}}
						/>
					) : (
						<div className="col-main">
							<nav className="tabs">
								<button
									type="button"
									className={`tab ${copilotTab === "transcripts" ? "on" : ""}`}
									onClick={() => setCopilotTab("transcripts")}
								>
									Transcripts
								</button>
								<button
									type="button"
									className={`tab ${copilotTab === "files" ? "on" : ""}`}
									onClick={() => setCopilotTab("files")}
								>
									Files
								</button>
								<button
									type="button"
									className={`tab ${copilotTab === "limits" ? "on" : ""}`}
									onClick={() => setCopilotTab("limits")}
								>
									Limits
								</button>
							</nav>
							<div className="tab-body">
								{copilotTab === "transcripts" && <CopilotTranscriptsPanel />}
								{copilotTab === "files" && <CopilotFilesPanel />}
								{copilotTab === "limits" && <CopilotLimitsPanel />}
							</div>
						</div>
					)}
				</div>
				<CopilotPanel />
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
				budgetPaused={view.demo ? false : budgetPaused}
				onBack={() => {
					window.location.search = "";
				}}
				missionId={view.demo ? undefined : (view.mission ?? undefined)}
			/>
			{agentError && view.mission && (
				<AgentErrorBanner
					error={agentError}
					missionId={view.mission}
					onDismiss={dismissAgentError}
				/>
			)}
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
						<button
							type="button"
							className={`tab ${mainTab === "limits" ? "on" : ""}`}
							onClick={() => setMainTab("limits")}
						>
							Limits
						</button>
						<button
							type="button"
							className={`tab ${mainTab === "schedule" ? "on" : ""}`}
							onClick={() => setMainTab("schedule")}
						>
							Schedule
						</button>
						<button
							type="button"
							className={`tab ${mainTab === "config" ? "on" : ""}`}
							onClick={() => setMainTab("config")}
						>
							Config
						</button>
						<button
							type="button"
							className={`tab ${mainTab === "log" ? "on" : ""}`}
							onClick={() => setMainTab("log")}
						>
							Log
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
						{mainTab === "limits" && <LimitsPanel missionId={view.mission} />}
						{mainTab === "schedule" && (
							<SchedulePanel missionId={view.mission} />
						)}
						{mainTab === "config" && <ConfigPanel missionId={view.mission} />}
						{mainTab === "log" && <LogPanel missionId={view.mission} />}
					</div>
				</main>
			</div>
		</div>
	);
}
