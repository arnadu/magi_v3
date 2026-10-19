import { Type } from "@sinclair/typebox";
import { MISSION_COPILOT_AGENT_ID } from "./mission-copilot.js";
import type { MissionCopilotToolDeps } from "./mission-copilot-tool-deps.js";
import { err, okJson } from "./mission-copilot-tool-result.js";
import { type ObjectiveDef, ObjectiveDefSchema } from "./objectives/types.js";
import type { MagiTool } from "./tools.js";

// ─── Family B — Objectives & Task Definition ────────────────────────────
function readMissionObjectivesTool(deps: MissionCopilotToolDeps): MagiTool {
	const { missionId, objectivesRepo } = deps;
	return {
		name: "ReadMissionObjectives",
		description:
			"Read the mission's full objective tree — every objective, owner, status, KPIs with current values, budget vs. spend, and tasks under it. Use to check whether teammates have clear goals and whether actions still track them.",
		parameters: Type.Object({}),
		async execute() {
			try {
				const tree = await objectivesRepo.readTree(missionId);
				return okJson(tree);
			} catch (e) {
				return err(`Failed to read objectives: ${(e as Error).message}`);
			}
		},
	};
}

function editObjectiveTreeTool(deps: MissionCopilotToolDeps): MagiTool {
	const { missionId, objectivesRepo, auditPost } = deps;
	return {
		name: "EditObjectiveTree",
		description:
			"Replace the mission's objective tree (definitions + KPI definitions — not task/KPI status, which agents update themselves via AddTask/UpdateTask/RecordKpi). This is a full replace, not a merge: call ReadMissionObjectives first, edit the objectives array in memory, and pass the complete updated list back. This is the only way to change objective/KPI definitions — agents cannot write them directly.",
		parameters: Type.Object({
			objectives: Type.Array(Type.Record(Type.String(), Type.Unknown()), {
				description:
					"The complete replacement objective tree (flat array, parent field encodes nesting)",
			}),
		}),
		async execute(_id, args) {
			let parsed: ObjectiveDef[];
			try {
				parsed = ObjectiveDefSchema.array().parse(args.objectives);
			} catch (e) {
				return err(`Invalid objectives: ${(e as Error).message}`);
			}
			try {
				await objectivesRepo.saveGoals(
					missionId,
					{ objectives: parsed },
					MISSION_COPILOT_AGENT_ID,
				);
				await auditPost(
					"Objective tree updated",
					`The mission copilot replaced the objective tree (${parsed.length} objective(s)).`,
				);
				return okJson({ ok: true, objectiveCount: parsed.length });
			} catch (e) {
				return err(`Failed to save objectives: ${(e as Error).message}`);
			}
		},
	};
}

export function createObjectivesTools(deps: MissionCopilotToolDeps) {
	return {
		readMissionObjectives: readMissionObjectivesTool(deps),
		editObjectiveTree: editObjectiveTreeTool(deps),
	};
}
