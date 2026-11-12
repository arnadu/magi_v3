import { storedCollection } from "@magi/agent-config";
import {
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
			"only reads from this store. Works on a draft, a running or a suspended mission; no " +
			"operator confirmation required (same trust tier as AssessKpi).\n\n" +
			"Objective: { id, title, owner (agent id accountable), parent (id or null), " +
			"status? (proposed|active|achieved|abandoned), description?, budgetUsd?, kpis? }.\n" +
			"KPI: { id, label, owner (agent id), kind (quantitative|qualitative), source " +
			"(auto-stat|task-rollup|agent-reported|copilot-assessment|manual), target?, unit?, " +
			"metricKey? (auto-stat: objectiveCostUsd), rubric? (how a qualitative KPI is judged) }.\n" +
			'Example: [{"id":"O1","parent":null,"title":"Brand identity","owner":' +
			'"creative-director","kpis":[{"id":"K1","label":"brand book quality",' +
			'"owner":"creative-director","kind":"qualitative","source":' +
			'"copilot-assessment","rubric":"Would a designer start from it?"}]}]',
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

export function createObjectiveTools(deps: CopilotToolDeps) {
	return {
		reviewObjectives: reviewObjectivesTool(deps),
		assessKpi: assessKpiTool(deps),
		saveObjectiveTree: saveObjectiveTreeTool(deps),
	};
}
