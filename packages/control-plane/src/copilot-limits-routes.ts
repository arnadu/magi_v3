/**
 * GET/PATCH /api/copilot/limits — how a user manages their control-plane
 * copilot's spend cap from the cockpit (Copilot → Limits). There is always a
 * cap (CST-3): PATCH null resets it to the default, and above the platform
 * ceiling only a platform admin may go (ADR-0034).
 */

import type { Request, Response } from "express";
import type { Db } from "mongodb";
import type { asyncRoutes } from "./async-handler.js";
import {
	COPILOT_MAX_TURN_MS,
	DEFAULT_COPILOT_SPEND_CAP_USD,
	effectiveCopilotCap,
	readCopilotSpend,
} from "./copilot-spend.js";
import {
	mayExceedPlatformCeiling,
	platformMaxCostCeilingUsd,
} from "./spend-policy.js";
import { setCopilotSpendCap } from "./users.js";

/** GET /api/copilot/limits — mirrored by the cockpit's CopilotLimits. */
export interface CopilotLimitsBody {
	/** The cap in force — the user's own, or the default. */
	capUsd: number;
	isDefault: boolean;
	defaultCapUsd: number;
	/** The highest cap this user may set; null for a platform admin. */
	ceilingUsd: number | null;
	spentUsd: number;
	maxTurnMinutes: number;
}

export function registerCopilotLimitsRoutes(
	routes: ReturnType<typeof asyncRoutes>,
	db: Db,
): void {
	routes.get("/limits", async (req: Request, res: Response) => {
		const missionId = `copilot-${req.userId}`;
		const [cap, spentUsd] = await Promise.all([
			effectiveCopilotCap(db, req.userId),
			readCopilotSpend(db, missionId),
		]);
		const body: CopilotLimitsBody = {
			capUsd: cap.capUsd,
			isDefault: cap.isDefault,
			defaultCapUsd: DEFAULT_COPILOT_SPEND_CAP_USD,
			ceilingUsd: mayExceedPlatformCeiling(req)
				? null
				: platformMaxCostCeilingUsd(),
			spentUsd,
			maxTurnMinutes: Math.round(COPILOT_MAX_TURN_MS / 60_000),
		};
		res.json(body);
	});

	// A number sets the cap; null resets it to the default. There is no way to
	// remove it (CST-3), and above the platform ceiling only an admin may go.
	routes.patch("/limits", async (req: Request, res: Response) => {
		const { capUsd } = req.body as { capUsd?: number | null };
		if (
			capUsd !== null &&
			(typeof capUsd !== "number" || !Number.isFinite(capUsd))
		) {
			res.status(400).json({
				error: "capUsd must be a number, or null to reset to the default",
			});
			return;
		}
		if (capUsd !== null && capUsd <= 0) {
			res.status(400).json({ error: "capUsd must be positive" });
			return;
		}
		if (capUsd !== null && !mayExceedPlatformCeiling(req)) {
			const ceiling = platformMaxCostCeilingUsd();
			if (capUsd > ceiling) {
				res.status(403).json({
					error: `A copilot cap of $${capUsd.toFixed(2)} is above the platform ceiling of $${ceiling.toFixed(2)}. Ask a platform admin to set it higher (see docs/spend-limits.md).`,
				});
				return;
			}
		}
		await setCopilotSpendCap(db, req.userId, capUsd ?? undefined);
		const cap = await effectiveCopilotCap(db, req.userId);
		res.json({ ok: true, ...cap });
	});
}
