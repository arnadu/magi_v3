/**
 * Mission config repository — ADR-0018 (extends ADR-0017's "read fresh, no cache"
 * principle from cost metrics to limit configuration), ADR-0021 (structured
 * storage — reads/writes the `mission`/`agents`/`missionCopilotLimits` fields
 * directly, no YAML parse/patch).
 *
 * The `missions` collection's `mission`/`agents`/`missionCopilotLimits` fields
 * are the single source of truth for limit *configuration*, exactly as
 * `missionStats` is for cost *metrics*. They are loaded once at daemon boot
 * and never re-read from there — this module lets callers read the CURRENT
 * persisted config on demand instead, so an operator's cockpit edit (or a
 * mission copilot's `SetMissionSpendCap` tool call) is visible on the very
 * next check, with no suspend/resume cycle required.
 */

import { parseTeamConfig, type TeamConfig } from "@magi/agent-config";
import type { Db } from "mongodb";
import {
	createMongoMissionConfigWriter,
	type MissionConfigWriter,
} from "./mission-config-revisions.js";

export interface MissionConfigRepository {
	/**
	 * Fresh-validated TeamConfig from the mission's persisted structured
	 * fields. Returns null (logged) when the mission doc or its `mission`/
	 * `agents` fields are absent, or when they fail validation.
	 */
	readTeamConfig(missionId: string): Promise<TeamConfig | null>;
	/**
	 * Patch, validate, and persist a new mission-wide spend cap. Throws on a
	 * missing mission doc or missing structured fields — callers decide how
	 * to surface that (e.g. an HTTP 400/404).
	 */
	writeMissionCap(missionId: string, maxCostUsd: number): Promise<void>;
}

export function createMongoMissionConfigRepository(
	db: Db,
): MissionConfigRepository {
	const missions = db.collection<{
		missionId: string;
		mission?: TeamConfig["mission"];
		agents?: TeamConfig["agents"];
		missionCopilotLimits?: TeamConfig["missionCopilotLimits"];
	}>("missions");
	const writer: MissionConfigWriter = createMongoMissionConfigWriter(db);

	return {
		async readTeamConfig(missionId) {
			const doc = await missions.findOne(
				{ missionId },
				{ projection: { mission: 1, agents: 1, missionCopilotLimits: 1 } },
			);
			if (!doc?.mission || !doc.agents) return null;
			try {
				return parseTeamConfig({
					mission: doc.mission,
					agents: doc.agents,
					missionCopilotLimits: doc.missionCopilotLimits,
				});
			} catch (e) {
				console.error(
					`[mission-config] failed to validate structured config { missionId: ${missionId} }: ${(e as Error).message}`,
				);
				return null;
			}
		},

		async writeMissionCap(missionId, maxCostUsd) {
			const doc = await missions.findOne(
				{ missionId },
				{ projection: { mission: 1, agents: 1, missionCopilotLimits: 1 } },
			);
			if (!doc?.mission || !doc.agents) {
				throw new Error(`No structured config stored for mission ${missionId}`);
			}
			const validated = parseTeamConfig({
				mission: { ...doc.mission, maxCostUsd },
				agents: doc.agents,
				missionCopilotLimits: doc.missionCopilotLimits,
			});
			await writer.write(
				missionId,
				{
					mission: validated.mission,
					agents: validated.agents,
					missionCopilotLimits: validated.missionCopilotLimits,
				},
				"system",
			);
		},
	};
}
