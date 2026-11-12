/**
 * The config checks a copilot action must pass, run twice: when the copilot
 * proposes the action (so it fixes a bad payload before the operator ever
 * sees a card) and again when the operator confirms it (the stored config may
 * have changed in between, e.g. the operator edited the draft).
 */

import {
	type AgentConfig,
	applyTeamConfigPatch,
	type Limits,
	type MissionDoc,
	parseTeamConfig,
	storedCollection,
	type TeamConfig,
	validateTeamFiles,
} from "@magi/agent-config";
import { assertKnownModels } from "@magi/agent-runtime-worker";
import type { Db } from "mongodb";

/** A draft's stored config as it would launch; throws, naming the problem, if it can't. */
export function validateDraftForLaunch(draft: MissionDoc): TeamConfig {
	let validated: TeamConfig;
	try {
		validated = parseTeamConfig({
			mission: draft.mission,
			agents: draft.agents,
			missionCopilotLimits: draft.missionCopilotLimits,
		});
		assertKnownModels(validated.mission);
	} catch (e) {
		throw new Error(`Invalid team config: ${(e as Error).message}`);
	}
	validateTeamFiles(draft.teamFiles ?? []);
	return validated;
}

/** A save_session_config payload applied to the stored mission; throws if the result is invalid. */
export function validateSessionConfigPatch(
	mission: MissionDoc,
	payload: Record<string, unknown>,
): TeamConfig {
	if (!mission.mission || !mission.agents) {
		throw new Error(
			`Mission ${mission.missionId} has no structured config stored`,
		);
	}
	let validated: TeamConfig;
	try {
		validated = applyTeamConfigPatch(
			{ ...mission, mission: mission.mission, agents: mission.agents },
			mission.missionId,
			{
				mission: payload.mission as Partial<TeamConfig["mission"]> | undefined,
				agents: payload.agents as AgentConfig[] | undefined,
				missionCopilotLimits: payload.missionCopilotLimits as
					| Limits
					| undefined,
			},
		);
		assertKnownModels(validated.mission, mission.mission);
	} catch (e) {
		throw new Error(`Invalid team config: ${(e as Error).message}`);
	}
	// TF1/CHAIN-A: team files are copilot-authored and reach the daemon's
	// filesystem.
	if (payload.teamFiles !== undefined) {
		validateTeamFiles(
			payload.teamFiles as Array<{ path: string; content: string }>,
		);
	}
	return validated;
}

/**
 * The problem a proposed action would hit at confirmation, or null. Only the
 * action types whose payload depends on stored config are checked here; the
 * rest are fully validated by their schema at proposal already.
 */
export async function preflightAction(
	db: Db,
	type: string,
	payload: Record<string, unknown>,
	userId: string,
): Promise<string | null> {
	if (type !== "launch_draft" && type !== "save_session_config") return null;
	const missionId = payload.missionId as string;
	const mission = await storedCollection(db, "missions").findOne({
		missionId,
		userId,
	});
	if (!mission) return `Mission "${missionId}" not found`;
	try {
		if (type === "launch_draft") {
			if (mission.status !== "draft") {
				return `Mission "${missionId}" is not a draft (status: ${mission.status})`;
			}
			validateDraftForLaunch(mission);
		} else {
			validateSessionConfigPatch(mission, payload);
		}
	} catch (e) {
		return (e as Error).message;
	}
	return null;
}
