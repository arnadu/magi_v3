/**
 * Machine-runtime reporting for the cockpit's Runtime tab (ADR-0031
 * Decision 1) — deliberately separate from `missions.ts`'s Limits routes,
 * which cover the $ spend cap and the upgraded-runtime cap; this is the
 * read-only, non-enforcement runtime-by-config report.
 */

import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type { Db } from "mongodb";
import { listSegments, runtimeByConfig } from "./machine-segments.js";

interface MissionDocLike {
	missionId: string;
	userId: string;
}

/** Admin sees all missions; regular users see only their own — same rule as missions.ts's userFilter. */
function userFilter(req: Request): Partial<MissionDocLike> {
	return req.isAdmin ? {} : { userId: req.userId };
}

const DAY_MS = 86_400_000;

/** Time horizons the Runtime tab reports over. `since` is computed fresh per request, not cached. */
function horizons(now: Date): Record<string, Date> {
	const todayStart = new Date(now);
	todayStart.setUTCHours(0, 0, 0, 0);
	return {
		today: todayStart,
		"7d": new Date(now.getTime() - 7 * DAY_MS),
		"30d": new Date(now.getTime() - 30 * DAY_MS),
		lifetime: new Date(0),
	};
}

export function createMissionResourceRoutes(db: Db): Router {
	const router = createRouter();
	const missions = db.collection<MissionDocLike>("missions");

	router.get("/:id/machine-runtime", async (req: Request, res: Response) => {
		const missionId = req.params.id;
		const mission = await missions.findOne({
			missionId,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}

		const now = new Date();
		const byHorizon: Record<string, ReturnType<typeof runtimeByConfig>> = {};
		for (const [key, since] of Object.entries(horizons(now))) {
			const segments = await listSegments(db, missionId, since);
			byHorizon[key] = runtimeByConfig(segments, { since, now });
		}

		res.json({ byHorizon });
	});

	return router;
}
