import {
	type AgentConfig,
	applyTeamConfigPatch,
	type Limits,
	type MissionDoc,
	storedCollection,
	type TeamConfig,
	validateTeamFiles,
} from "@magi/agent-config";
import { Type } from "@sinclair/typebox";
import type { Db } from "mongodb";
import { createMongoMissionConfigRepository } from "./mission-config.js";
import { MISSION_COPILOT_AGENT_ID } from "./mission-copilot.js";
import type { MissionCopilotToolDeps } from "./mission-copilot-tool-deps.js";
import { err, okJson } from "./mission-copilot-tool-result.js";
import { wrapTrustBoundary } from "./mission-copilot-tool-text.js";
import { assertKnownModels } from "./models.js";
import type { MagiTool } from "./tools.js";

// ─── Family A — Mission & Team Configuration ────────────────────────────
function readMissionConfigTool(deps: MissionCopilotToolDeps): MagiTool {
	const { db, missionId } = deps;
	return {
		name: "ReadMissionConfig",
		description:
			"Read this mission's current team configuration — mission name/model, every agent's role/system prompt/skills — and its attached team files. Use before proposing any change.",
		parameters: Type.Object({}),
		async execute() {
			const mission = await storedCollection(db, "missions").findOne({
				missionId,
			});
			if (!mission) return err(`Mission "${missionId}" not found`);
			const teamFiles = (
				(mission.teamFiles as Array<{ path: string; content: string }>) ?? []
			).map((f) => ({
				path: f.path,
				contentPreview: wrapTrustBoundary(
					`team file: ${f.path}`,
					f.content.length > 2000 ? `${f.content.slice(0, 2000)}…` : f.content,
				),
			}));
			return okJson({
				mission: mission.mission ?? null,
				agents: mission.agents ?? [],
				missionCopilotLimits: mission.missionCopilotLimits ?? null,
				teamFiles,
			});
		},
	};
}

const SAVE_MISSION_CONFIG_PARAMS = Type.Object({
	mission: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description:
				"Partial mission fields to merge in (e.g. { name, model, maxCostUsd }). Omit to leave unchanged.",
		}),
	),
	agents: Type.Optional(
		Type.Array(Type.Record(Type.String(), Type.Unknown()), {
			description:
				"Full agent objects to upsert by id into the current roster. Omit to leave the roster unchanged.",
		}),
	),
	missionCopilotLimits: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description:
				"Replaces the current value wholesale. Omit to leave unchanged.",
		}),
	),
	teamFiles: Type.Optional(
		Type.Array(
			Type.Object({
				path: Type.String(),
				content: Type.String(),
			}),
			{
				description:
					"Attached team files (skills, playbooks, etc.). Omit to preserve the mission's current files — do not pass [] unless you intend to clear them all.",
			},
		),
	),
});

/** The patched config, validated, with only known models — or the refusal. */
function mergeConfigPatch(
	current: MissionDoc & Required<Pick<MissionDoc, "mission" | "agents">>,
	missionId: string,
	patch: {
		missionPatch?: Partial<TeamConfig["mission"]>;
		agentsPatch?: AgentConfig[];
		missionCopilotLimitsPatch?: Limits;
	},
): { config: TeamConfig } | { error: string } {
	try {
		const config = applyTeamConfigPatch(current, missionId, {
			mission: patch.missionPatch,
			agents: patch.agentsPatch,
			missionCopilotLimits: patch.missionCopilotLimitsPatch,
		});
		assertKnownModels(config.mission, current.mission);
		return { config };
	} catch (e) {
		return { error: `Invalid team config: ${(e as Error).message}` };
	}
}

/**
 * F-025: SetMissionSpendCap checks the ceiling through writeMissionCap, but
 * mission.maxCostUsd is also a plain field this tool can merge — without
 * this, a second, unguarded path to the same unilateral cap raise. The
 * ceiling itself lives outside every field a mission tool can write.
 * Returns the refusal, or null when the cap is unchanged or within it.
 */
async function capAboveCeiling(
	db: Db,
	missionId: string,
	nextCap: number | undefined,
	currentCap: number | undefined,
): Promise<string | null> {
	if (nextCap === undefined || nextCap === currentCap) return null;
	const ceiling =
		await createMongoMissionConfigRepository(db).readMaxCostCeiling(missionId);
	if (ceiling === null || nextCap <= ceiling) return null;
	return `Requested cap $${nextCap.toFixed(2)} exceeds this mission's spend-cap ceiling of $${ceiling.toFixed(2)} — raise the ceiling first via the cockpit Limits panel (an operator-only action no mission tool can perform).`;
}

function saveMissionConfigTool(deps: MissionCopilotToolDeps): MagiTool {
	const { db, missionId, missionConfigWriter, auditPost } = deps;
	return {
		name: "SaveMissionConfig",
		description:
			"Patch this mission's structured team configuration. Validated before saving — an invalid resulting config is rejected with the specific error and nothing is written. Most changes (system prompt, agent roster, models, skills) take effect the next time the mission is resumed, not immediately. The exception: changes to an agent's `limits` or `mission.maxCostUsd` apply on the very next limit check, no resume needed. Read current config with ReadMissionConfig first, then pass only what needs to change.\n\n" +
			"`mission`, if passed, is shallow-merged into the current mission object (omit a field to keep its current value; `id` is always preserved as this mission's own id regardless of what's passed). `agents`, if passed, is upserted by `id` into the current roster — an existing id is replaced, a new id is appended; to remove an agent, set its `active: false` rather than omitting it from the array (omitting an existing agent from this list does NOT delete it). `missionCopilotLimits`, if passed, replaces the current value wholesale. Omit any of the three top-level fields entirely to leave it untouched.\n\n" +
			"teamFiles rules: omit teamFiles entirely to preserve whatever the mission already has attached; pass teamFiles explicitly to replace them. WARNING: passing teamFiles: [] will clear all attached files — only do this intentionally.",
		parameters: SAVE_MISSION_CONFIG_PARAMS,
		async execute(_id, args) {
			const missionPatch = args.mission as
				| Partial<TeamConfig["mission"]>
				| undefined;
			const agentsPatch = args.agents as AgentConfig[] | undefined;
			const missionCopilotLimitsPatch = args.missionCopilotLimits as
				| Limits
				| undefined;
			const teamFilesProvided = args.teamFiles !== undefined;
			const teamFiles = args.teamFiles as
				| Array<{ path: string; content: string }>
				| undefined;

			const current = await storedCollection(db, "missions").findOne({
				missionId,
			});
			if (!current?.mission || !current.agents) {
				return err(`Mission "${missionId}" has no structured config stored`);
			}

			const merged = mergeConfigPatch(
				{ ...current, mission: current.mission, agents: current.agents },
				missionId,
				{ missionPatch, agentsPatch, missionCopilotLimitsPatch },
			);
			if ("error" in merged) return err(merged.error);
			const validated = merged.config;
			// TF1/CHAIN-A: teamFiles is agent/LLM-authored here and reaches the
			// daemon's filesystem unvalidated otherwise (team-files-sync.ts).
			if (teamFilesProvided && teamFiles) {
				try {
					validateTeamFiles(teamFiles);
				} catch (e) {
					return err((e as Error).message);
				}
			}

			const ceilingProblem = await capAboveCeiling(
				db,
				missionId,
				validated.mission.maxCostUsd,
				current.mission.maxCostUsd,
			);
			if (ceilingProblem) return err(ceilingProblem);

			await missionConfigWriter.write(
				missionId,
				{
					mission: validated.mission,
					agents: validated.agents,
					missionCopilotLimits: validated.missionCopilotLimits,
				},
				MISSION_COPILOT_AGENT_ID,
			);
			// Omitting teamFiles must preserve whatever the mission already has —
			// defaulting to [] here silently wiped every attached team file
			// (goals.json, tasks.jsonl, skills) on any config-only edit, e.g. a
			// simple system-prompt tweak. Matches save_template's former (now
			// removed, ADR-0021) "omit to preserve" contract.
			if (teamFilesProvided) {
				await storedCollection(db, "missions").updateOne(
					{ missionId },
					{ $set: { teamFiles } },
				);
			}
			await auditPost(
				"Mission config updated",
				"I updated this mission's team configuration. Most changes take effect the " +
					"next time the mission is resumed, not immediately — except `limits` and " +
					"`mission.maxCostUsd`, which apply on the very next check.",
			);
			return okJson({ ok: true });
		},
	};
}

export function createConfigTools(deps: MissionCopilotToolDeps) {
	return {
		readMissionConfig: readMissionConfigTool(deps),
		saveMissionConfig: saveMissionConfigTool(deps),
	};
}
