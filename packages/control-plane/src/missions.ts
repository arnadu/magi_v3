/**
 * Mission CRUD + lifecycle routes.
 *
 * POST   /api/missions              — provision a new mission
 * POST   /api/missions/draft        — create a draft mission (no machine, no validation gate)
 * GET    /api/missions              — list all missions
 * GET    /api/missions/:id          — get one mission
 * GET    /api/missions/:id/config   — get structured config + live mental maps
 * PUT    /api/missions/:id/config   — update structured config + mental maps (suspended only)
 * PUT    /api/missions/:id/draft    — update a draft's config (draft only, permissive)
 * POST   /api/missions/:id/launch   — validate + provision a draft, flips it to running
 * POST   /api/missions/:id/suspend  — stop execution machine
 * POST   /api/missions/:id/resume   — start execution machine
 * DELETE /api/missions/:id          — destroy machine + volume (irreversible)
 */

import {
	type AgentConfig,
	type Limits,
	parseTeamConfig,
	type TeamConfig,
} from "@magi/agent-config";
import {
	createMongoAgentStatsRepository,
	createMongoObjectivesRepository,
	UPGRADE_LIMITS,
} from "@magi/agent-runtime-worker";
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Collection, Db } from "mongodb";
import { asyncRoutes } from "./async-handler.js";
import { upgradedMsSince } from "./machine-segments.js";
import {
	effectiveSoftOf,
	postLimitsAudit,
	type RouteResult,
} from "./mission-limits.js";
import { registerMissionConfigRoutes } from "./mission-routes-config.js";
import { registerMissionLaunchRoutes } from "./mission-routes-launch.js";
import { registerMissionLifecycleRoutes } from "./mission-routes-lifecycle.js";
import { registerMissionLimitsRoutes } from "./mission-routes-limits.js";
import { registerMissionReadRoutes } from "./mission-routes-read.js";
import { registerMissionTranscriptRoutes } from "./mission-routes-transcript.js";
import { monitorAuthHeaders } from "./monitor-token.js";

export interface MissionDoc {
	missionId: string;
	/** Firebase UID of the owner, or "admin" for CONTROL_API_KEY-created missions. */
	userId: string;
	name: string;
	teamConfig: string;
	/** Structured config (ADR-0021) — the live source of truth. */
	mission?: TeamConfig["mission"];
	agents?: AgentConfig[];
	missionCopilotLimits?: Limits;
	/**
	 * Operator-only spend-cap ceiling (issue #49 / F-025) — deliberately a
	 * top-level field, never part of `mission`/`agents`/`missionCopilotLimits`,
	 * so no execution-plane tool (SaveMissionConfig, SetMissionSpendCap) can
	 * ever read or write it; only writeMissionCostCeiling() below touches it,
	 * gated by this router's own requireAuth. undefined means no ceiling is
	 * configured (legacy/opt-in) — writeMissionCap imposes no upper bound.
	 */
	maxCostCeilingUsd?: number;
	/** Team files (skills, etc.) stored at provision time; updated on config edit. */
	teamFiles?: Array<{ path: string; content: string }>;
	machineId?: string;
	privateIp?: string;
	volumeId?: string;
	status:
		| "draft"
		| "provisioning"
		| "running"
		| "suspended"
		| "destroyed"
		| "error";
	/** Set when status === "error"; cleared on successful resume. */
	errorMessage?: string;
	/** Set while a machine resize (ADR-0031) is in flight; see resource-upgrade.ts. */
	resize?: { claimedAt?: Date; lastAt?: Date };
	/** Present while the mission is on an upgraded machine (ADR-0031). */
	upgrade?: {
		cpuKind: string;
		cpus: number;
		memoryMb: number;
		expiresAt: Date;
		requestedByAgentId?: string;
	};
	/** Operator-only reset point for the cumulative upgraded-runtime cap (ADR-0031 Decision 7);
	 *  written only by writeUpgradedRuntimeReset() below, never by any execution-plane path. */
	upgradedRuntimeResetAt?: Date;
	createdAt: Date;
	updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Limits (cockpit Limits panel) — GET/PATCH read+write current & configured
// budget/limit state. Every limit (mission-wide cap, per-agent, mission
// copilot's own) lives in the mission doc's structured `mission`/`agents`/
// `missionCopilotLimits` fields (ADR-0021). Exported as plain functions,
// separate from the Express handlers that wrap them, so tests can call them
// directly against real Mongo (this repo has no supertest-equivalent
// HTTP-route test pattern — see copilot-tools.integration.test.ts for the
// precedent this follows).
// ---------------------------------------------------------------------------

export interface AgentLimitsRow {
	agentId: string;
	limits: Partial<Limits>;
	effectiveSoft: {
		warnLlmCallsPerTurn: number;
		warnPeakContextTokens: number;
		warnToolErrorsPerTurn: number;
		warnConsecutiveZeroOutputTurns: number;
	};
	live: {
		lifetimeCostUsd: number | null;
		lifetimeLlmCallCount: number | null;
		consecutiveZeroOutputTurns: number | null;
		mostRecentTurn: {
			turnNumber: number;
			llmCallCount: number;
			costUsd: number;
			peakContextTokens: number;
			toolErrorsTotal: number;
		} | null;
	};
}

export interface LimitsData {
	mission: {
		maxCostUsd: number | null;
		missionTotalUsd: number | null;
		budgetPaused: boolean | null;
		/** Issue #49 / F-025 — operator-only ceiling; null means none configured. */
		maxCostCeilingUsd: number | null;
	};
	agents: AgentLimitsRow[];
	missionRunning: boolean;
	/** Temporary machine upgrades (ADR-0031 Decision 7). */
	upgrades: {
		usedHours: number;
		capHours: number;
		/** ISO timestamp of the operator's last reset, or null if never reset. */
		resetAt: string | null;
		active: {
			cpuKind: string;
			cpus: number;
			memoryMb: number;
			expiresAt: string;
			requestedByAgentId?: string;
		} | null;
	};
}

export async function readLimits(
	col: Collection<MissionDoc>,
	db: Db,
	missionId: string,
	filter: Partial<MissionDoc>,
): Promise<RouteResult> {
	const mission = await col.findOne({ missionId, ...filter });
	if (!mission) return { status: 404, body: { error: "Not found" } };
	if (!mission.mission || !mission.agents) {
		return {
			status: 404,
			body: { error: "No config stored for this mission" },
		};
	}

	let teamConfig: TeamConfig;
	try {
		teamConfig = parseTeamConfig({
			mission: mission.mission,
			agents: mission.agents,
			missionCopilotLimits: mission.missionCopilotLimits,
		});
	} catch (e) {
		return {
			status: 500,
			body: { error: `Stored config is invalid: ${(e as Error).message}` },
		};
	}

	const missionRunning = mission.status === "running";

	// Lifetime numbers — own query, not the existing GET /mission-stats route
	// (its projection excludes consecutiveZeroOutputTurns, and that route is
	// monitor-proxied so it's unreachable while suspended anyway). Call count
	// and the zero-output streak have no live/in-flight equivalent worth
	// tracking (they're inherently "as of the last completed turn"), so those
	// two still come straight from missionStats.
	const statsDocs = await db
		.collection("missionStats")
		.find(
			{ missionId },
			{
				projection: {
					agentId: 1,
					lifetimeLlmCallCount: 1,
					consecutiveZeroOutputTurns: 1,
					_id: 0,
				},
			},
		)
		.toArray();
	const statsByAgent = new Map(statsDocs.map((d) => [d.agentId as string, d]));

	// The dollar figure, by contrast, IS what a limit is actually checked
	// against — reuse the exact same persisted-lifetime + in-flight-turn
	// combination enforceLimits/the mission-wide cap check use
	// (readMissionSnapshot, agent-stats.ts), rather than a second,
	// independent sum that only reads the persisted total and can therefore
	// under-report a live mission by the cost of whatever turn is currently
	// in flight for that agent.
	const snapshot =
		await createMongoAgentStatsRepository(db).readMissionSnapshot(missionId);
	const costByAgent = new Map(
		snapshot.map((s) => [s.agentId, s.lifetimeCostUsd + s.turnCostUsd]),
	);

	// Authored roster + the synthesized mission-copilot row (daemon-injected,
	// never in agents[] — its limits live in the top-level missionCopilotLimits
	// field instead).
	const roster: Array<{ agentId: string; limits: Partial<Limits> }> = [
		...teamConfig.agents.map((a) => ({
			agentId: a.id,
			limits: a.limits ?? {},
		})),
		{
			agentId: "mission-copilot",
			limits: teamConfig.missionCopilotLimits ?? {},
		},
	];

	const agents: AgentLimitsRow[] = [];
	for (const { agentId, limits } of roster) {
		const mostRecentDocs = await db
			.collection("agentTurnStats")
			.find({ missionId, agentId, completedAt: { $exists: true } })
			.sort({ turnNumber: -1 })
			.limit(1)
			.toArray();
		const mrt = mostRecentDocs[0];
		const stats = statsByAgent.get(agentId);
		agents.push({
			agentId,
			limits,
			effectiveSoft: effectiveSoftOf(limits),
			live: {
				lifetimeCostUsd: costByAgent.get(agentId) ?? null,
				lifetimeLlmCallCount: (stats?.lifetimeLlmCallCount as number) ?? null,
				consecutiveZeroOutputTurns:
					(stats?.consecutiveZeroOutputTurns as number) ?? null,
				mostRecentTurn: mrt
					? {
							turnNumber: mrt.turnNumber as number,
							llmCallCount: (mrt.llmCallCount as number) ?? 0,
							costUsd: (mrt.costUsd as number) ?? 0,
							peakContextTokens: (mrt.peakContextTokens as number) ?? 0,
							toolErrorsTotal: Object.values(
								(mrt.toolErrors ?? {}) as Record<string, number>,
							).reduce((a, b) => a + b, 0),
						}
					: null,
			},
		});
	}

	// Best-effort — the mission's own live state, only reachable while running.
	let missionTotalUsd: number | null = null;
	let budgetPaused: boolean | null = null;
	if (missionRunning && mission.privateIp) {
		try {
			const res = await fetch(`http://[${mission.privateIp}]:4000/status`, {
				headers: monitorAuthHeaders(mission.missionId),
				signal: AbortSignal.timeout(5_000),
			});
			if (res.ok) {
				const s = (await res.json()) as {
					missionTotalUsd?: number;
					budgetPaused?: boolean;
				};
				missionTotalUsd = s.missionTotalUsd ?? null;
				budgetPaused = s.budgetPaused ?? null;
			}
		} catch {
			// Monitor unreachable — leave both null rather than fail the route.
		}
	}

	const resetSince = mission.upgradedRuntimeResetAt ?? new Date(0);
	const usedMs = await upgradedMsSince(
		db,
		missionId,
		resetSince,
		new Date(),
		"elapsed",
	);

	const data: LimitsData = {
		mission: {
			maxCostUsd: teamConfig.mission.maxCostUsd ?? null,
			missionTotalUsd,
			budgetPaused,
			maxCostCeilingUsd: mission.maxCostCeilingUsd ?? null,
		},
		agents,
		missionRunning,
		upgrades: {
			usedHours: usedMs / 3_600_000,
			capHours: UPGRADE_LIMITS.cumulativeCapHours,
			resetAt: mission.upgradedRuntimeResetAt?.toISOString() ?? null,
			active: mission.upgrade
				? {
						cpuKind: mission.upgrade.cpuKind,
						cpus: mission.upgrade.cpus,
						memoryMb: mission.upgrade.memoryMb,
						expiresAt: mission.upgrade.expiresAt.toISOString(),
						...(mission.upgrade.requestedByAgentId && {
							requestedByAgentId: mission.upgrade.requestedByAgentId,
						}),
					}
				: null,
		},
	};
	return { status: 200, body: data };
}

/**
 * Operator-only reset of the cumulative upgraded-runtime cap (ADR-0031
 * Decision 7). Writes directly to the top-level `upgradedRuntimeResetAt`
 * field — same structural-separation pattern as `writeMissionCostCeiling`
 * (F-025): no execution-plane tool can ever reach this field or this write
 * path, only the Firebase-authenticated cockpit Limits route.
 */
export async function writeUpgradedRuntimeReset(
	col: Collection<MissionDoc>,
	db: Db,
	missionId: string,
	filter: Partial<MissionDoc>,
): Promise<RouteResult> {
	const mission = await col.findOne({ missionId, ...filter });
	if (!mission) return { status: 404, body: { error: "Not found" } };

	const resetAt = new Date();
	await col.updateOne(
		{ missionId },
		{ $set: { upgradedRuntimeResetAt: resetAt, updatedAt: resetAt } },
	);

	await postLimitsAudit(
		db,
		missionId,
		"Upgraded-runtime counter reset",
		`Operator reset this mission's cumulative upgraded-machine-runtime counter to 0 via the cockpit Limits panel (was counting since ${mission.upgradedRuntimeResetAt ? mission.upgradedRuntimeResetAt.toISOString() : "the mission's creation"}).`,
	);

	return { status: 200, body: { ok: true, resetAt: resetAt.toISOString() } };
}

/**
 * Folded objectives tree, read directly from MongoDB (ADR-0019) — unlike the
 * old proxy-through-MonitorServer path this replaces, this works regardless
 * of mission running state (the same "readLimits works while suspended"
 * property ADR-0018 already gave cost/limits).
 */
export async function readObjectives(
	col: Collection<MissionDoc>,
	db: Db,
	missionId: string,
	filter: Partial<MissionDoc>,
): Promise<RouteResult> {
	const mission = await col.findOne({ missionId, ...filter });
	if (!mission) return { status: 404, body: { error: "Not found" } };
	const tree = await createMongoObjectivesRepository(db).readTree(missionId);
	return { status: 200, body: tree };
}

export {
	postLimitsAudit,
	writeAgentLimits,
	writeMissionCap,
	writeMissionCostCeiling,
} from "./mission-limits.js";

export function createMissionsRouter(db: Db): Router {
	const router = createRouter();
	const routes = asyncRoutes(router);
	const col = db.collection<MissionDoc>("missions");

	// Create userId index on first router mount (idempotent).
	void col.createIndex({ userId: 1, createdAt: -1 });

	for (const register of [
		registerMissionReadRoutes,
		registerMissionTranscriptRoutes,
		registerMissionConfigRoutes,
		registerMissionLaunchRoutes,
		registerMissionLimitsRoutes,
		registerMissionLifecycleRoutes,
	]) {
		register(routes, { db, col });
	}

	return router;
}
