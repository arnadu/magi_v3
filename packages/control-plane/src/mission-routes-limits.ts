/**
 * Missions API — The Limits panel (spend cap, ceiling, per-agent limits, upgrade counter) and the objectives tree.
 * Registered by `createMissionsRouter` (missions.ts) in the original order.
 */

import type { RequestHandler } from "express";
import type { AsyncRoutes } from "./async-handler.js";
import {
	writeAgentLimits,
	writeMissionCap,
	writeMissionCostCeiling,
} from "./mission-limits.js";
import type { MissionRouteDeps } from "./mission-scope.js";
import { userFilter } from "./mission-scope.js";
import {
	readLimits,
	readObjectives,
	writeUpgradedRuntimeReset,
} from "./missions.js";

function getLimits({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const result = await readLimits(col, db, req.params.id, userFilter(req));
		res.status(result.status).json(result.body);
	};
}

// ── Objectives (cockpit ObjectivesPanel) — reads Mongo directly, works
// regardless of mission running state (ADR-0019).
function getObjectives({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const result = await readObjectives(
			col,
			db,
			req.params.id,
			userFilter(req),
		);
		res.status(result.status).json(result.body);
	};
}

function patchLimitsMission({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const maxCostUsd = req.body?.maxCostUsd;
		if (typeof maxCostUsd !== "number") {
			res.status(400).json({ error: "maxCostUsd (number) is required" });
			return;
		}
		const result = await writeMissionCap(
			col,
			db,
			req.params.id,
			userFilter(req),
			maxCostUsd,
		);
		res.status(result.status).json(result.body);
	};
}

function patchLimitsCeiling({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const ceilingUsd = req.body?.ceilingUsd;
		if (typeof ceilingUsd !== "number") {
			res.status(400).json({ error: "ceilingUsd (number) is required" });
			return;
		}
		const result = await writeMissionCostCeiling(
			col,
			db,
			req.params.id,
			userFilter(req),
			ceilingUsd,
			Boolean(req.isAdmin),
		);
		res.status(result.status).json(result.body);
	};
}

// ADR-0031 Decision 7 — operator-only reset of the cumulative
// upgraded-machine-runtime cap. See writeUpgradedRuntimeReset's own doc
// comment for why this is a separate write path, mirroring F-025.
function patchLimitsUpgradeReset({
	db,
	col,
}: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const result = await writeUpgradedRuntimeReset(
			col,
			db,
			req.params.id,
			userFilter(req),
		);
		res.status(result.status).json(result.body);
	};
}

function patchLimitsAgent({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const limits = req.body?.limits;
		if (
			limits !== null &&
			(typeof limits !== "object" || Array.isArray(limits))
		) {
			res.status(400).json({ error: "limits (object or null) is required" });
			return;
		}
		const result = await writeAgentLimits(
			col,
			db,
			req.params.id,
			userFilter(req),
			req.params.agentId,
			limits,
		);
		res.status(result.status).json(result.body);
	};
}

export function registerMissionLimitsRoutes(
	routes: AsyncRoutes,
	deps: MissionRouteDeps,
): void {
	routes.get("/:id/limits", getLimits(deps));
	routes.get("/:id/objectives", getObjectives(deps));
	routes.patch("/:id/limits/mission", patchLimitsMission(deps));
	routes.patch("/:id/limits/ceiling", patchLimitsCeiling(deps));
	routes.patch("/:id/limits/upgrade-reset", patchLimitsUpgradeReset(deps));
	routes.patch("/:id/limits/agent/:agentId", patchLimitsAgent(deps));
}
