/**
 * Creating a draft mission: a mission document with status "draft", no
 * machine and no spend. The operator (cockpit) and the control-plane copilot
 * (CreateDraft) both create drafts here, so a draft looks the same whoever
 * started it and both can edit it until it is launched.
 */

import {
	type AgentConfig,
	type Limits,
	type TeamConfig,
	validateNewMissionId,
} from "@magi/agent-config";
import type { Collection } from "mongodb";
import type { MissionDoc } from "./mission-scope.js";
import {
	platformMaxCostCeilingUsd,
	withDefaultSpendCap,
} from "./spend-policy.js";
import { getTemplate } from "./templates.js";

export interface DraftRequest {
	missionId: string;
	name: string;
	/** Template id to copy agents, mission settings and team files from; omit for a blank draft. */
	templateId?: string;
	userId: string;
}

export type DraftCreation =
	| { ok: true; doc: MissionDoc }
	| { ok: false; status: 400 | 404 | 409; error: string };

export async function createDraftMission(
	col: Collection<MissionDoc>,
	req: DraftRequest,
): Promise<DraftCreation> {
	const { missionId, name, templateId, userId } = req;
	if (!missionId || !name?.trim()) {
		return { ok: false, status: 400, error: "missionId and name are required" };
	}
	try {
		validateNewMissionId(missionId);
	} catch (e) {
		return { ok: false, status: 400, error: (e as Error).message };
	}
	if (await col.findOne({ missionId }, { projection: { _id: 1 } })) {
		return { ok: false, status: 409, error: "Mission already exists" };
	}

	let mission: TeamConfig["mission"];
	let agents: AgentConfig[];
	let missionCopilotLimits: Limits | undefined;
	let teamFiles: Array<{ path: string; content: string }>;
	if (templateId) {
		const template = getTemplate(templateId);
		if (!template) {
			return {
				ok: false,
				status: 404,
				error: `Unknown template "${templateId}"`,
			};
		}
		mission = { ...template.config.mission, id: missionId, name };
		agents = template.config.agents;
		missionCopilotLimits = template.config.missionCopilotLimits;
		teamFiles = template.teamFiles;
	} else {
		mission = { id: missionId, name };
		agents = [];
		teamFiles = [];
	}

	const now = new Date();
	const doc: MissionDoc = {
		missionId,
		userId,
		name,
		teamConfig: templateId ?? "blank",
		mission: withDefaultSpendCap(mission),
		agents,
		missionCopilotLimits,
		teamFiles,
		maxCostCeilingUsd: platformMaxCostCeilingUsd(),
		status: "draft",
		createdAt: now,
		updatedAt: now,
	};
	try {
		await col.insertOne(doc);
	} catch (e) {
		if ((e as { code?: number }).code === 11000) {
			return { ok: false, status: 409, error: "Mission already exists" };
		}
		throw e;
	}
	return { ok: true, doc };
}
