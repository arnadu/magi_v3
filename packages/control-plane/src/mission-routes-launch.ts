/**
 * Missions API — Launching a draft.
 * Registered by `createMissionsRouter` (missions.ts) in the original order.
 */

import { parseTeamConfig, type TeamConfig } from "@magi/agent-config";
import { assertKnownModels } from "@magi/agent-runtime-worker";
import type { RequestHandler } from "express";
import type { AsyncRoutes } from "./async-handler.js";
import { isLocalExecution, provisionLocal } from "./fly-machines.js";
import { provisionTracked } from "./machine-lifecycle.js";
import {
	claimStatus,
	persistVolumeId,
	runningPatch,
} from "./mission-claims.js";
import type { MissionRouteDeps } from "./mission-scope.js";
import { userFilter } from "./mission-scope.js";
import { ensureMissionSpendCap } from "./spend-policy.js";

// Validate and launch a draft — the only point at which a draft's config must be fully
// valid (parseTeamConfig). Provisions a real machine on success, mirroring POST /'s
// provisioning try/catch exactly.
function postLaunch({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		if (mission.status !== "draft") {
			res.status(409).json({ error: "Mission is not a draft" });
			return;
		}

		let validated: TeamConfig;
		try {
			validated = parseTeamConfig({
				mission: mission.mission,
				agents: mission.agents,
				missionCopilotLimits: mission.missionCopilotLimits,
			});
			assertKnownModels(validated.mission);
		} catch (e) {
			res
				.status(400)
				.json({ error: `Invalid team config: ${(e as Error).message}` });
			return;
		}

		if (!(await claimStatus(col, req.params.id, "draft", "provisioning"))) {
			res.status(409).json({ error: "Mission is already being launched" });
			return;
		}
		try {
			// Also covers a local launch, which skips provisionTracked.
			await ensureMissionSpendCap(db, req.params.id);
			const handle = isLocalExecution()
				? provisionLocal(req.params.id, { teamFiles: mission.teamFiles ?? [] })
				: await provisionTracked(db, req.params.id, {
						memoryMb: validated.mission.memoryMb,
						cpus: validated.mission.cpus,
						onVolumeCreated: persistVolumeId(col, req.params.id),
					});
			await col.updateOne(
				{ missionId: req.params.id },
				{
					$set: runningPatch(handle),
				},
			);
			res.status(200).json({ ...mission, ...handle, status: "running" });
		} catch (e) {
			const errorMessage = (e as Error).message;
			console.error(
				`[missions] draft launch failed { missionId: "${req.params.id}", error: "${errorMessage}" }`,
			);
			await col.updateOne(
				{ missionId: req.params.id },
				{ $set: { status: "error", errorMessage, updatedAt: new Date() } },
			);
			res.status(500).json({ error: errorMessage });
		}
	};
}

export function registerMissionLaunchRoutes(
	routes: AsyncRoutes,
	deps: MissionRouteDeps,
): void {
	routes.post("/:id/launch", postLaunch(deps));
}
