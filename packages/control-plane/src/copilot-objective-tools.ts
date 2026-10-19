import {
	type AgentConfig,
	type Limits,
	storedCollection,
	type TeamConfig,
} from "@magi/agent-config";
import {
	createMongoMissionConfigWriter,
	createMongoObjectivesRepository,
	type MagiTool,
	type ObjectiveDef,
	ObjectiveDefSchema,
} from "@magi/agent-runtime-worker";
import { Type } from "@sinclair/typebox";
import { type CopilotToolDeps, err, ok } from "./copilot-tool-deps.js";

// ─── Objectives (Sprint 26a, C1; MongoDB-direct since ADR-0019) ──────────

function reviewObjectivesTool(deps: CopilotToolDeps): MagiTool {
	const { db, userId } = deps;
	const objectivesRepo = createMongoObjectivesRepository(db);
	return {
		name: "ReviewObjectives",
		description:
			"Read a mission's objective tree with current task status, KPI values, " +
			"and budget-vs-spend. Use this to assess progress and decide which KPIs to update. " +
			"Works whether the mission is running or suspended.",
		parameters: Type.Object({
			missionId: Type.String({ description: "Mission ID" }),
		}),
		async execute(_id, args) {
			const missionId = args.missionId as string;
			const mission = await storedCollection(db, "missions").findOne({
				missionId,
				userId,
			});
			if (!mission) return err(`Mission "${missionId}" not found.`);
			try {
				const tree = await objectivesRepo.readTree(missionId);
				return ok(JSON.stringify(tree, null, 2));
			} catch (e) {
				return err(`Failed to read objectives: ${(e as Error).message}`);
			}
		},
	};
}

function assessKpiTool(deps: CopilotToolDeps): MagiTool {
	const { db, pushEvent, userId } = deps;
	const objectivesRepo = createMongoObjectivesRepository(db);
	return {
		name: "AssessKpi",
		description:
			"Record a value for a KPI you assess (a copilot-assessment KPI). The latest " +
			"value wins. Use after ReviewObjectives to publish your judgement (e.g. " +
			'a coverage rubric: "met" / "partial" / "unmet", or a computed number). ' +
			"Works whether the mission is running or suspended.",
		parameters: Type.Object({
			missionId: Type.String({ description: "Mission ID" }),
			kpi: Type.String({
				description: "KPI id (from the objective tree), e.g. K1",
			}),
			value: Type.Union([Type.String(), Type.Number()], {
				description: "The value to record (string rubric or number)",
			}),
			note: Type.Optional(
				Type.String({ description: "Optional rationale for the assessment" }),
			),
		}),
		async execute(_id, args) {
			const missionId = args.missionId as string;
			const mission = await storedCollection(db, "missions").findOne({
				missionId,
				userId,
			});
			if (!mission) return err(`Mission "${missionId}" not found.`);
			try {
				await objectivesRepo.appendKpiEvent(missionId, {
					kpi: args.kpi as string,
					value: args.value as string | number,
					by: "copilot",
					at: new Date().toISOString(),
					...(args.note !== undefined ? { note: args.note as string } : {}),
				});
				pushEvent("copilot-kpi", {
					missionId,
					kpi: args.kpi,
					value: args.value,
				});
				return ok(`Recorded ${args.kpi} = ${args.value}`);
			} catch (e) {
				return err(`Failed to record KPI: ${(e as Error).message}`);
			}
		},
	};
}

function saveObjectiveTreeTool(deps: CopilotToolDeps): MagiTool {
	const { db, userId } = deps;
	const objectivesRepo = createMongoObjectivesRepository(db);
	return {
		name: "SaveObjectiveTree",
		description:
			"Replace a mission's objective tree (definitions + KPI definitions — not task/KPI " +
			"status, which agents update themselves during the mission). This is a full replace, " +
			"not a merge: call ReviewObjectives first if objectives may already exist, edit the " +
			"array in memory, and pass the complete updated list back. Use this — not " +
			"write_mission_file/save_session_config's teamFiles — to set up a mission's objectives: " +
			"objectives placed in a team file are invisible to the cockpit's Objectives panel, which " +
			"only reads from this store. Works whether the mission is running or suspended; no " +
			"operator confirmation required (same trust tier as AssessKpi).",
		parameters: Type.Object({
			missionId: Type.String({ description: "Mission ID" }),
			objectives: Type.Array(Type.Record(Type.String(), Type.Unknown()), {
				description:
					"The complete replacement objective tree (flat array, parent field encodes nesting)",
			}),
		}),
		async execute(_id, args) {
			const missionId = args.missionId as string;
			const mission = await storedCollection(db, "missions").findOne({
				missionId,
				userId,
			});
			if (!mission) return err(`Mission "${missionId}" not found.`);
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
					"copilot",
				);
				return ok(
					`Objective tree saved for mission "${missionId}" (${parsed.length} objective(s)).`,
				);
			} catch (e) {
				return err(`Failed to save objectives: ${(e as Error).message}`);
			}
		},
	};
}

function editDraftConfigTool(deps: CopilotToolDeps): MagiTool {
	const { db, userId } = deps;
	return {
		name: "EditDraftConfig",
		description:
			"Directly edit a draft mission's config — mission-level fields and agents (add, " +
			"update, or remove). Unlike SaveMissionConfig/save_session_config on a live mission, " +
			"this needs no operator confirmation and no full config validity: a draft has no " +
			"running agent to collide with and no spend at risk, so you can build up an " +
			"incomplete roster over several calls. Full validation only happens at launch " +
			"(ProposeAction type launch_draft). Agents are upserted by id — an existing id " +
			"replaces that agent, a new id adds one; use removeAgentIds to delete agents outright " +
			"(a real delete, not the active:false convention live missions are stuck with).",
		parameters: Type.Object({
			missionId: Type.String({ description: "Draft mission ID" }),
			mission: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), {
					description:
						"Partial mission-level fields to merge in (name, model, visionModel, " +
						"timezone, maxCostUsd, memoryMb, cpus)",
				}),
			),
			agents: Type.Optional(
				Type.Array(Type.Record(Type.String(), Type.Unknown()), {
					description:
						"Agents to add or update (upserted by id) — id, name, role, supervisor, " +
						"systemPrompt, initialMentalMap, limits, disabledSkills, disabledTools",
				}),
			),
			removeAgentIds: Type.Optional(
				Type.Array(Type.String(), {
					description: "Agent ids to remove from the roster entirely",
				}),
			),
			missionCopilotLimits: Type.Optional(
				Type.Record(Type.String(), Type.Unknown()),
			),
			teamFiles: Type.Optional(
				Type.Array(
					Type.Object({ path: Type.String(), content: Type.String() }),
				),
			),
		}),
		async execute(_id, args) {
			const missionId = args.missionId as string;
			const mission = await storedCollection(db, "missions").findOne({
				missionId,
				userId,
			});
			if (!mission) return err(`Mission "${missionId}" not found.`);
			if (mission.status !== "draft") {
				return err(
					`Mission "${missionId}" is not a draft (current status: ${mission.status}).`,
				);
			}

			const missionPatch = args.mission as
				| Partial<TeamConfig["mission"]>
				| undefined;
			const agentsPatch = args.agents as AgentConfig[] | undefined;
			const removeAgentIds = new Set(
				(args.removeAgentIds as string[] | undefined) ?? [],
			);
			const missionCopilotLimitsPatch = args.missionCopilotLimits as
				| Limits
				| undefined;
			const teamFiles = args.teamFiles as
				| Array<{ path: string; content: string }>
				| undefined;

			const currentAgents = mission.agents ?? [];
			const nextAgents = [
				...currentAgents.filter(
					(a) =>
						!removeAgentIds.has(a.id) &&
						!(agentsPatch ?? []).some((p) => p.id === a.id),
				),
				...(agentsPatch ?? []).filter((a) => !removeAgentIds.has(a.id)),
			];
			const nextMission = {
				...(mission.mission ?? { id: missionId, name: mission.name }),
				...missionPatch,
				id: missionId,
			};
			const nextMissionCopilotLimits =
				missionCopilotLimitsPatch ?? mission.missionCopilotLimits;

			await createMongoMissionConfigWriter(db).write(
				missionId,
				{
					mission: nextMission,
					agents: nextAgents,
					missionCopilotLimits: nextMissionCopilotLimits,
				},
				"copilot",
			);
			if (teamFiles !== undefined) {
				await storedCollection(db, "missions").updateOne(
					{ missionId },
					{ $set: { teamFiles, updatedAt: new Date() } },
				);
			}
			return ok(
				`Draft "${missionId}" updated — ${nextAgents.length} agent(s) in roster.`,
			);
		},
	};
}

export function createObjectiveTools(deps: CopilotToolDeps) {
	return {
		reviewObjectives: reviewObjectivesTool(deps),
		assessKpi: assessKpiTool(deps),
		saveObjectiveTree: saveObjectiveTreeTool(deps),
		editDraftConfig: editDraftConfigTool(deps),
	};
}
