/**
 * Mission config repository — ADR-0018 (extends ADR-0017's "read fresh, no cache"
 * principle from cost metrics to limit configuration).
 *
 * `teamConfigYaml` (the `missions` collection's canonical, human-edited config —
 * agent definitions, `limits`, `mission.maxCostUsd`) is the single source of
 * truth for limit *configuration*, exactly as `missionStats` is for cost
 * *metrics*. It is loaded once at daemon boot (`loadTeamConfig()`) and never
 * re-read from there — this module lets callers read the CURRENT persisted
 * config on demand instead, so an operator's cockpit edit (or a mission
 * copilot's `SetMissionSpendCap` tool call) is visible on the very next check,
 * with no suspend/resume cycle required.
 *
 * `teamConfigYaml` is a small text blob (agent definitions + the mission node;
 * `teamFiles` is a separate top-level field), so a full parse-and-validate per
 * call is cheap relative to LLM call latency — unlike cost metrics, there is no
 * need for a denormalized fast-read aggregate here.
 */

import {
	parseTeamConfig,
	patchMissionCap,
	type TeamConfig,
} from "@magi/agent-config";
import type { Db } from "mongodb";

export interface MissionConfigRepository {
	/**
	 * Fresh-parsed TeamConfig from the mission's persisted teamConfigYaml.
	 * Returns null (logged) when the mission doc or its teamConfigYaml is
	 * absent, or when the stored YAML fails to parse/validate.
	 */
	readTeamConfig(missionId: string): Promise<TeamConfig | null>;
	/**
	 * Patch, validate, and persist a new mission-wide spend cap. Throws on a
	 * missing mission doc, missing teamConfigYaml, or invalid resulting config
	 * — callers decide how to surface that (e.g. an HTTP 400/404).
	 */
	writeMissionCap(missionId: string, maxCostUsd: number): Promise<void>;
}

export function createMongoMissionConfigRepository(
	db: Db,
): MissionConfigRepository {
	const missions = db.collection<{
		missionId: string;
		teamConfigYaml?: string;
	}>("missions");

	return {
		async readTeamConfig(missionId) {
			const doc = await missions.findOne(
				{ missionId },
				{ projection: { teamConfigYaml: 1 } },
			);
			if (!doc?.teamConfigYaml) return null;
			try {
				return parseTeamConfig(doc.teamConfigYaml);
			} catch (e) {
				console.error(
					`[mission-config] failed to parse teamConfigYaml { missionId: ${missionId} }: ${(e as Error).message}`,
				);
				return null;
			}
		},

		async writeMissionCap(missionId, maxCostUsd) {
			const doc = await missions.findOne(
				{ missionId },
				{ projection: { teamConfigYaml: 1 } },
			);
			if (!doc?.teamConfigYaml) {
				throw new Error(`No teamConfigYaml stored for mission ${missionId}`);
			}
			const patched = patchMissionCap(doc.teamConfigYaml, maxCostUsd);
			parseTeamConfig(patched); // validate before persisting
			await missions.updateOne(
				{ missionId },
				{ $set: { teamConfigYaml: patched, updatedAt: new Date() } },
			);
		},
	};
}
