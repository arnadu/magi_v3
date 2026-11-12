/**
 * The control-plane copilot's draft tools: create a draft mission, read any
 * mission's stored config, and edit a draft. A draft has no machine and no
 * spend, so these need no confirmation; the operator sees and can edit the
 * same draft in the cockpit, and only `launch_draft` (a confirmed action)
 * provisions it, from whatever the draft holds at that moment.
 */

import {
	type AgentConfig,
	type Limits,
	storedCollection,
	type TeamConfig,
	validateTeamFiles,
} from "@magi/agent-config";
import {
	createMongoMissionConfigWriter,
	type MagiTool,
} from "@magi/agent-runtime-worker";
import { Type } from "@sinclair/typebox";
import { type CopilotToolDeps, err, ok } from "./copilot-tool-deps.js";
import { createDraftMission } from "./mission-drafts.js";

function createDraftTool(deps: CopilotToolDeps): MagiTool {
	const { db, userId } = deps;
	return {
		name: "CreateDraft",
		description:
			"Create a draft mission: stored config only, no machine, no spend, no confirmation. " +
			"Start blank (add agents with EditDraftConfig) or from a template's agents, " +
			"settings and team files (templateId). The operator sees the draft in the cockpit " +
			"and can edit it there too; launch it with ProposeAction launch_draft once it is " +
			"complete. The mission id is a lowercase slug and must not exist yet. Before you " +
			"write any agent, read the agent-design skill (its SKILL.md path is in your skills " +
			"list) and the mission-creation workflow in magi-template-design.",
		parameters: Type.Object({
			missionId: Type.String({
				description: "New mission id: lowercase letters, digits and hyphens",
			}),
			name: Type.String({ description: "Display name" }),
			templateId: Type.Optional(
				Type.String({
					description:
						"Template to copy from (ListTemplates); omit for a blank draft",
				}),
			),
		}),
		async execute(_id, args) {
			const created = await createDraftMission(
				storedCollection(db, "missions"),
				{
					missionId: args.missionId as string,
					name: args.name as string,
					templateId: args.templateId as string | undefined,
					userId,
				},
			);
			if (!created.ok) return err(created.error);
			const d = created.doc;
			const origin =
				d.teamConfig === "blank" ? "scratch" : `template ${d.teamConfig}`;
			return ok(
				`Draft "${d.missionId}" created from ${origin}: ${d.agents?.length ?? 0} agent(s), ` +
					`${d.teamFiles?.length ?? 0} team file(s), cap $${d.mission?.maxCostUsd}. ` +
					"Next: EditDraftConfig and SaveObjectiveTree, then ProposeAction launch_draft.",
			);
		},
	};
}

function readMissionConfigTool(deps: CopilotToolDeps): MagiTool {
	const { db, userId } = deps;
	return {
		name: "ReadMissionConfig",
		description:
			"Read a mission's stored config — draft, running or suspended: mission settings, " +
			"every agent (prompt, initial mental map, supervisor, limits, disabled tools and " +
			"skills, active flag) and the team files' paths and sizes. Read a draft again " +
			"before proposing launch_draft: the operator may have edited it in the cockpit.",
		parameters: Type.Object({
			missionId: Type.String({ description: "Mission ID" }),
		}),
		async execute(_id, args) {
			const missionId = args.missionId as string;
			const m = await storedCollection(db, "missions").findOne({
				missionId,
				userId,
			});
			if (!m) return err(`Mission "${missionId}" not found.`);
			const view = {
				missionId: m.missionId,
				status: m.status,
				updatedAt: m.updatedAt,
				mission: m.mission,
				agents: m.agents ?? [],
				missionCopilotLimits: m.missionCopilotLimits,
				teamFiles: (m.teamFiles ?? []).map((f) => ({
					path: f.path,
					bytes: Buffer.byteLength(f.content, "utf8"),
				})),
			};
			return ok(JSON.stringify(view, null, 1));
		},
	};
}

function editDraftConfigTool(deps: CopilotToolDeps): MagiTool {
	const { db, userId } = deps;
	return {
		name: "EditDraftConfig",
		description:
			"Directly edit a draft mission's config — mission-level fields and agents (add, " +
			"update, or remove). Unlike save_session_config on a live mission, this needs no " +
			"operator confirmation and no full config validity: a draft has no running agent " +
			"and no spend at risk, so you can build up an incomplete roster over several calls. " +
			"Full validation happens when you propose launch_draft. Agents are upserted by id — " +
			"an existing id replaces that agent, a new id adds one; removeAgentIds deletes agents " +
			"outright. Setting mission.name renames the mission. Every agent you write must " +
			"pass the agent-design checklist (read that skill first): who and why, mandate and " +
			"boundaries, output contract with paths, how a turn goes and when to stop, who to " +
			"message, {{mentalMap}} at the end; and no agent ever asks for an API key — data " +
			"providers are reached through the platform.",
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
					{ description: "Replaces the draft's team files wholesale" },
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
			if (teamFiles !== undefined) {
				// Paths reach the daemon's filesystem at launch: refuse a bad one
				// now, not at the operator's confirmation.
				try {
					validateTeamFiles(teamFiles);
				} catch (e) {
					return err((e as Error).message);
				}
			}

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

			await createMongoMissionConfigWriter(db).write(
				missionId,
				{
					mission: nextMission,
					agents: nextAgents,
					missionCopilotLimits:
						missionCopilotLimitsPatch ?? mission.missionCopilotLimits,
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

export function createDraftTools(deps: CopilotToolDeps) {
	return {
		createDraft: createDraftTool(deps),
		readMissionConfig: readMissionConfigTool(deps),
		editDraftConfig: editDraftConfigTool(deps),
	};
}
