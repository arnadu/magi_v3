/**
 * The copilot's `launch_mission` action, executed after operator
 * confirmation. The mission document is the claim (EA5/LAUNCH1): inserted
 * first, in status "provisioning", so a concurrent launch of the same id
 * fails on the unique index instead of creating a second machine and volume,
 * and a crash during provisioning leaves a visible document, not an orphan.
 */

import { validateNewMissionId } from "@magi/agent-config";
import type { Db } from "mongodb";
import type { ActionPayload } from "./copilot-actions.js";
import { provisionTracked } from "./machine-lifecycle.js";
import { getTemplate } from "./templates.js";

export async function executeLaunchMission(
	db: Db,
	payload: ActionPayload<"launch_mission">,
	userId: string,
	now: Date,
): Promise<string> {
	const missions = db.collection("missions");
	const missionId = payload.missionId;
	// MID1: the id here is LLM-authored; same namespace rule as POST /.
	validateNewMissionId(missionId);
	const name = payload.name ?? missionId;
	const templateId = payload.templateId;

	const template = getTemplate(templateId);
	if (!template) throw new Error(`Template "${templateId}" not found`);

	const resolvedMission = { ...template.config.mission, id: missionId };
	try {
		await missions.insertOne({
			missionId,
			userId,
			name,
			teamConfig: templateId,
			mission: resolvedMission,
			agents: template.config.agents,
			missionCopilotLimits: template.config.missionCopilotLimits,
			teamFiles: template.teamFiles,
			status: "provisioning",
			createdAt: now,
			updatedAt: now,
		});
	} catch (e) {
		if ((e as { code?: number }).code === 11000) {
			throw new Error(`Mission "${missionId}" already exists`);
		}
		throw e;
	}
	try {
		const handle = await provisionTracked(db, missionId, {
			teamFiles: template.teamFiles,
			onVolumeCreated: async (volumeId) => {
				await missions.updateOne({ missionId }, { $set: { volumeId } });
			},
		});
		await missions.updateOne(
			{ missionId },
			{
				$set: {
					machineId: handle.machineId,
					privateIp: handle.privateIp,
					volumeId: handle.volumeId,
					status: "running",
					updatedAt: new Date(),
				},
			},
		);
		return `Mission "${missionId}" launched (machine: ${handle.machineId})`;
	} catch (e) {
		const errorMessage = (e as Error).message;
		await missions.updateOne(
			{ missionId },
			{ $set: { status: "error", errorMessage, updatedAt: new Date() } },
		);
		throw new Error(
			`Launch failed for mission "${missionId}": ${errorMessage}`,
		);
	}
}
