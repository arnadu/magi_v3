import type { StatsCollector } from "../agent-stats.js";
import { missionLifetimeCostUsd } from "../limits.js";
import {
	type MissionConfigRepository,
	SpendCapCeilingExceededError,
} from "../mission-config.js";
import type { MonitorEventType } from "../monitor-server.js";
import { readBody } from "../monitor-server.js";
import type { RouteEntry } from "./types.js";

/**
 * Both routes below funnel through MissionConfigRepository.writeMissionCap(),
 * which throws SpendCapCeilingExceededError (issue #49 / F-025) when the
 * requested cap exceeds the mission's maxCostCeilingUsd — a 403, not the
 * generic 500 any other write failure gets, so the caller (including the
 * mission-copilot's own SetMissionSpendCap tool) can tell "rejected by a
 * real containment boundary" apart from "something broke."
 */
function writeMissionCapErrorStatus(e: unknown): number {
	return e instanceof SpendCapCeilingExceededError ? 403 : 500;
}

/**
 * Accessor functions, not plain values: budgetPaused/budgetResolve are
 * mutated in place elsewhere on the MonitorServer instance (the budget-cap-
 * breach path, waitForBudget()) — a deps object built once at construction
 * time can't hold them by value without going stale.
 */
export interface BudgetDeps {
	missionId: string;
	missionConfig: MissionConfigRepository;
	statsCollector: StatsCollector;
	getBudgetPaused: () => boolean;
	setBudgetPaused: (paused: boolean) => void;
	getBudgetResolve: () => (() => void) | null;
	setBudgetResolve: (fn: (() => void) | null) => void;
	push: (type: MonitorEventType, payload: unknown) => void;
	statusPayload: () => Promise<unknown>;
}

/** POST /extend-budget, /set-budget — operator-driven spend-cap changes. */
export function createBudgetRoutes(deps: BudgetDeps): RouteEntry[] {
	return [
		{
			method: "POST",
			path: "/extend-budget",
			async handler({ req, res }) {
				const body = await readBody(req);
				let addUsd = 5;
				try {
					const parsed = JSON.parse(body) as Record<string, unknown>;
					if (typeof parsed.addUsd === "number" && parsed.addUsd > 0) {
						addUsd = parsed.addUsd;
					}
				} catch {
					// Malformed JSON — use default $5
				}
				// Read the current persisted cap fresh — never a locally-cached value
				// (ADR-0018) — so this adds on top of whatever the cap actually is,
				// including a value set by another writer (cockpit, mission copilot)
				// since this process last checked.
				const live = await deps.missionConfig.readTeamConfig(deps.missionId);
				const previousCap = live?.mission.maxCostUsd ?? 0;
				const newCapUsd = previousCap + addUsd;
				try {
					await deps.missionConfig.writeMissionCap(deps.missionId, newCapUsd);
				} catch (e) {
					res.writeHead(writeMissionCapErrorStatus(e), {
						"Content-Type": "application/json",
					});
					res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
					return;
				}
				deps.setBudgetPaused(false);
				console.log(
					`[monitor] Budget extended by $${addUsd.toFixed(2)} — new cap: $${newCapUsd.toFixed(2)}`,
				);
				const budgetResolve = deps.getBudgetResolve();
				if (budgetResolve) {
					budgetResolve();
					deps.setBudgetResolve(null);
				}
				deps.push("cost-resumed", { addUsd, newCapUsd, budgetPaused: false });
				deps.push("status", await deps.statusPayload());
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, newCapUsd }));
			},
		},
		{
			method: "POST",
			path: "/set-budget",
			// cf. /extend-budget which adds; this sets an absolute spending cap.
			async handler({ req, res }) {
				const body = await readBody(req);
				let capUsd: number | null = null;
				try {
					const parsed = JSON.parse(body) as Record<string, unknown>;
					if (typeof parsed.capUsd === "number" && parsed.capUsd > 0) {
						capUsd = parsed.capUsd;
					}
				} catch {
					// fall through to validation error below
				}
				if (capUsd === null) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: false, error: "capUsd must be > 0" }));
					return;
				}
				// Persist first — this IS the source of truth from here on (ADR-0018);
				// there is no local cap value to also update.
				try {
					await deps.missionConfig.writeMissionCap(deps.missionId, capUsd);
				} catch (e) {
					res.writeHead(writeMissionCapErrorStatus(e), {
						"Content-Type": "application/json",
					});
					res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
					return;
				}
				// Lift the pause if the new cap is above what has actually been spent —
				// read fresh from missionStats (safety-critical: decides whether a
				// paused mission resumes), never from the session-only accumulator.
				if (deps.getBudgetPaused()) {
					const snapshot = await deps.statsCollector.readMissionSnapshot(
						deps.missionId,
					);
					if (capUsd > missionLifetimeCostUsd(snapshot)) {
						deps.setBudgetPaused(false);
						const budgetResolve = deps.getBudgetResolve();
						if (budgetResolve) {
							budgetResolve();
							deps.setBudgetResolve(null);
						}
						deps.push("cost-resumed", {
							newCapUsd: capUsd,
							budgetPaused: false,
						});
					}
				}
				console.log(`[monitor] Budget cap set to $${capUsd.toFixed(2)}`);
				deps.push("status", await deps.statusPayload());
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, newCapUsd: capUsd }));
			},
		},
	];
}
