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

/**
 * Thrown by writeMissionCap() when the requested cap exceeds the mission's
 * own maxCostCeilingUsd (issue #49 / finding F-025). Distinguished from a
 * generic write failure so callers (monitor-routes/budget.ts) can return a
 * 403 with a clear reason instead of a bare 500.
 */
export class SpendCapCeilingExceededError extends Error {
	constructor(
		public readonly requestedUsd: number,
		public readonly ceilingUsd: number,
	) {
		super(
			`Requested cap $${requestedUsd.toFixed(2)} exceeds this mission's spend-cap ceiling of $${ceilingUsd.toFixed(2)} — raise the ceiling first via the cockpit Limits panel (an operator-only action no mission tool can perform).`,
		);
		this.name = "SpendCapCeilingExceededError";
	}
}

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
	 * to surface that (e.g. an HTTP 400/404) — or SpendCapCeilingExceededError
	 * when the requested cap exceeds maxCostCeilingUsd.
	 */
	writeMissionCap(missionId: string, maxCostUsd: number): Promise<void>;
	/**
	 * Fresh read of the mission's spend-cap ceiling (issue #49 / F-025) — a
	 * top-level field on the `missions` document, deliberately outside the
	 * `mission`/`agents`/`missionCopilotLimits` structured-config fields that
	 * SaveMissionConfig/EditDraftConfig/PUT /:id/config can write, so no
	 * execution-plane tool can ever raise its own ceiling. null means no
	 * ceiling is configured for this mission (legacy/opt-in — see ADR note in
	 * the containment fix's commit) and writeMissionCap imposes no upper bound.
	 */
	readMaxCostCeiling(missionId: string): Promise<number | null>;
}

export function createMongoMissionConfigRepository(
	db: Db,
): MissionConfigRepository {
	const missions = db.collection<{
		missionId: string;
		mission?: TeamConfig["mission"];
		agents?: TeamConfig["agents"];
		missionCopilotLimits?: TeamConfig["missionCopilotLimits"];
		maxCostCeilingUsd?: number;
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

		async readMaxCostCeiling(missionId) {
			const doc = await missions.findOne(
				{ missionId },
				{ projection: { maxCostCeilingUsd: 1 } },
			);
			return doc?.maxCostCeilingUsd ?? null;
		},

		async writeMissionCap(missionId, maxCostUsd) {
			const doc = await missions.findOne(
				{ missionId },
				{
					projection: {
						mission: 1,
						agents: 1,
						missionCopilotLimits: 1,
						maxCostCeilingUsd: 1,
					},
				},
			);
			if (!doc?.mission || !doc.agents) {
				throw new Error(`No structured config stored for mission ${missionId}`);
			}
			if (
				doc.maxCostCeilingUsd !== undefined &&
				maxCostUsd > doc.maxCostCeilingUsd
			) {
				throw new SpendCapCeilingExceededError(
					maxCostUsd,
					doc.maxCostCeilingUsd,
				);
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
