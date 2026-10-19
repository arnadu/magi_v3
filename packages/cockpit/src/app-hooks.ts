/** The cockpit shell's state hooks: auth, which view to show, the live mission status stream, the mission name. */
import { useEffect, useState } from "react";
import { type AuthState, subscribeAuth } from "./auth";
import {
	AuthError,
	fetchMissionName,
	fetchMissions,
	fetchObjectives,
	type MissionSummary,
} from "./data";
import type { FoldedTree } from "./types";

/** Drives whether the cockpit shows the login screen or the rest of the app. */
export function useAuthState(): AuthState {
	const [state, setState] = useState<AuthState>({ status: "loading" });
	useEffect(() => subscribeAuth(setState), []);
	return state;
}

/** How often the cockpit re-fetches a live mission's objectives. */
const POLL_MS = 4000;

export type View =
	| { kind: "loading" }
	| {
			kind: "ready";
			tree: FoldedTree;
			mission: string | null;
			updatedAt: number;
	  }
	| { kind: "picker"; missions: MissionSummary[] }
	| { kind: "draft"; missionId: string }
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
export function useView(
	refreshKey: number,
	authStatus: AuthState["status"],
): View {
	const [view, setView] = useState<View>({ kind: "loading" });

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a deliberate manual-refetch trigger, not a value read inside the effect
	useEffect(() => {
		if (authStatus !== "signed-in") return;
		const params = new URLSearchParams(window.location.search);
		const mission = params.get("mission");
		const draft = params.get("draft");
		let cancelled = false;

		if (draft) {
			// A draft has no machine and no objectives to poll — the editor fetches
			// its own config directly (fetchMissionConfig), so this view is a
			// static routing decision, not a data load.
			setView({ kind: "draft", missionId: draft });
			return;
		}

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
			// A hidden tab keeps the last good tree; it refreshes when shown again.
			const timer = setInterval(() => {
				if (document.visibilityState !== "hidden") void load();
			}, POLL_MS);
			const onVisible = () => {
				if (document.visibilityState === "visible") void load();
			};
			document.addEventListener("visibilitychange", onVisible);
			return () => {
				cancelled = true;
				clearInterval(timer);
				document.removeEventListener("visibilitychange", onVisible);
			};
		}

		// No mission selected — offer the picker (the creation flow lives there,
		// so a signed-in user with zero missions lands there too). A failed
		// list fetch is shown as the failure it is: this used to fall back to a
		// bundled demo dashboard, which made an outage or a 500 look like a
		// working cockpit with odd data (CK2).
		(async () => {
			try {
				const missions = await fetchMissions();
				if (cancelled) return;
				setView({ kind: "picker", missions });
			} catch (e) {
				if (cancelled) return;
				if (e instanceof AuthError) {
					setView({ kind: "auth" });
					return;
				}
				setView({
					kind: "error",
					message: `Could not load your missions: ${(e as Error).message}`,
				});
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [refreshKey, authStatus]);

	return view;
}

export interface AgentError {
	agentId: string;
	errorMessage: string;
	transient: boolean;
}

export interface MissionStatus {
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

export function useMissionStatus(missionId: string | null): MissionStatus {
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

/** Self-fetches the mission's display name — same pattern as MissionStatusButton. */
export function useMissionName(missionId: string | undefined): string | null {
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
