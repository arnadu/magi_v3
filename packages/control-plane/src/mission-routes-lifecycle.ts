/**
 * Missions API — Creating a mission or a draft, suspending, resuming, and the disabled delete.
 * Registered by `createMissionsRouter` (missions.ts) in the original order.
 */

import {
	type AgentConfig,
	type Limits,
	parseTeamConfig,
	type TeamConfig,
	validateNewMissionId,
	validateTeamFiles,
} from "@magi/agent-config";
import { assertKnownModels } from "@magi/agent-runtime-worker";
import type { RequestHandler } from "express";
import type { AsyncRoutes } from "./async-handler.js";
import { isLocalExecution, provisionLocal } from "./fly-machines.js";
import { provisionTracked } from "./machine-lifecycle.js";
import { insertMissionOrConflict, runningPatch } from "./mission-claims.js";
import { createDraftMission } from "./mission-drafts.js";
import {
	type LifecycleResult,
	resumeMission,
	suspendMission,
} from "./mission-lifecycle-actions.js";
import type { MissionRouteDeps } from "./mission-scope.js";
import { type MissionDoc, userFilter } from "./mission-scope.js";
import {
	platformMaxCostCeilingUsd,
	withDefaultSpendCap,
} from "./spend-policy.js";
import { getTemplate } from "./templates.js";

/**
 * The structured config a new mission starts from: the caller's inline
 * config (validated, models checked, team-file paths checked — it is tenant
 * input that reaches the daemon's filesystem) or a template by name
 * (operator-authored on disk, already validated at load). An explicit error
 * either way — never a silent fallback to a generic default.
 */
function resolveCreateConfig(
	missionId: string,
	templateId: string,
	inline: {
		mission?: TeamConfig["mission"];
		agents?: AgentConfig[];
		missionCopilotLimits?: Limits;
		teamFiles?: Array<{ path: string; content: string }>;
	},
):
	| { config: TeamConfig; files: Array<{ path: string; content: string }> }
	| { status: number; error: string } {
	if (inline.mission && inline.agents) {
		let config: TeamConfig;
		try {
			config = parseTeamConfig({
				mission: { ...inline.mission, id: missionId },
				agents: inline.agents,
				missionCopilotLimits: inline.missionCopilotLimits,
			});
			assertKnownModels(config.mission);
		} catch (e) {
			return {
				status: 400,
				error: `Invalid team config: ${(e as Error).message}`,
			};
		}
		// TF1/CHAIN-A: same reason as PUT /:id/config.
		try {
			validateTeamFiles(inline.teamFiles ?? []);
		} catch (e) {
			return { status: 400, error: (e as Error).message };
		}
		return { config, files: inline.teamFiles ?? [] };
	}
	const template = getTemplate(templateId);
	if (!template)
		return { status: 404, error: `Unknown template "${templateId}"` };
	return {
		config: {
			...template.config,
			mission: { ...template.config.mission, id: missionId },
		},
		files: template.teamFiles,
	};
}

// Provision a new mission.
function createMission({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const {
			missionId,
			name,
			teamConfig,
			mission: inlineMission,
			agents: inlineAgents,
			missionCopilotLimits: inlineMissionCopilotLimits,
			teamFiles: inlineFiles,
		} = req.body as {
			missionId?: string;
			name?: string;
			teamConfig?: string;
			mission?: TeamConfig["mission"];
			agents?: AgentConfig[];
			missionCopilotLimits?: Limits;
			teamFiles?: Array<{ path: string; content: string }>;
		};
		if (!missionId || !name || !teamConfig) {
			res
				.status(400)
				.json({ error: "missionId, name, and teamConfig are required" });
			return;
		}
		// MID1: a caller-chosen id must not collide with a platform namespace
		// (e.g. copilot-<userId>, whose mailbox has no missions document).
		try {
			validateNewMissionId(missionId);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
			return;
		}

		// Resolve structured config BEFORE inserting the mission doc so a bad
		// payload or an unknown template name never leaves a stuck
		// "provisioning" document (ADR-0021).
		const resolved = resolveCreateConfig(missionId, teamConfig, {
			mission: inlineMission,
			agents: inlineAgents,
			missionCopilotLimits: inlineMissionCopilotLimits,
			teamFiles: inlineFiles,
		});
		if ("error" in resolved) {
			res.status(resolved.status).json({ error: resolved.error });
			return;
		}
		const { config: resolvedConfig, files: resolvedFiles } = resolved;

		const existing = await col.findOne({ missionId });
		if (existing) {
			res.status(409).json({ error: "Mission already exists" });
			return;
		}

		// Resolve teamFiles BEFORE inserting the mission doc so the daemon can
		// fetch them from MongoDB at startup instead of reading a large
		// TEAM_FILES_PAYLOAD env var (which would exceed Fly's machine config
		// limit for team configs with many skill files).
		const doc: MissionDoc = {
			missionId,
			userId: req.userId,
			name,
			teamConfig,
			mission: withDefaultSpendCap(resolvedConfig.mission),
			agents: resolvedConfig.agents,
			missionCopilotLimits: resolvedConfig.missionCopilotLimits,
			teamFiles: resolvedFiles,
			maxCostCeilingUsd: platformMaxCostCeilingUsd(),
			status: "provisioning",
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		if (!(await insertMissionOrConflict(col, doc, res))) return;

		try {
			// The daemon fetches team files from MongoDB in both modes. Locally the files
			// are also written to disk, for the developer to read; the daemon ignores that copy.
			const handle = isLocalExecution()
				? provisionLocal(missionId, { teamFiles: resolvedFiles })
				: await provisionTracked(db, missionId, {
						memoryMb: doc.mission?.memoryMb,
						cpus: doc.mission?.cpus,
					});
			await col.updateOne(
				{ missionId },
				{
					$set: runningPatch(handle),
				},
			);
			res.status(201).json({ ...doc, ...handle, status: "running" });
		} catch (e) {
			const errorMessage = (e as Error).message;
			console.error(
				`[missions] provision failed { missionId: "${missionId}", error: "${errorMessage}" }`,
			);
			await col.updateOne(
				{ missionId },
				{ $set: { status: "error", errorMessage, updatedAt: new Date() } },
			);
			res.status(500).json({ error: errorMessage });
		}
	};
}

// Create a draft mission — no machine, no validation gate. Cloned from a template
// (already-validated config) or blank (no agents yet). A blank draft intentionally
// fails TeamConfigSchema until filled in — full validation only runs at Launch
// (POST /:id/launch), not here, so the operator/copilot can build it up incrementally.
function postDraft({ col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const { missionId, name, teamConfig } = req.body as {
			missionId?: string;
			name?: string;
			/** Template id to clone from; omit for a blank draft. */
			teamConfig?: string;
		};
		const created = await createDraftMission(col, {
			missionId: missionId ?? "",
			name: name ?? "",
			templateId: teamConfig,
			userId: req.userId,
		});
		if (!created.ok) {
			res.status(created.status).json({ error: created.error });
			return;
		}
		res.status(201).json(created.doc);
	};
}

// Suspend.
/** The HTTP shape of a suspend/resume outcome. */
function sendLifecycle(
	res: Parameters<RequestHandler>[1],
	result: LifecycleResult,
	status: "suspended" | "running",
): void {
	if (result.ok) res.json({ status });
	else res.status(result.status).json({ error: result.error });
}

function postSuspend({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		sendLifecycle(res, await suspendMission(db, col, mission), "suspended");
	};
}

// Resume — the daemon reads structured config directly from `missions` at boot (ADR-0021).
function postResume({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		sendLifecycle(res, await resumeMission(db, col, mission), "running");
	};
}

// Mission destruction stays disabled (decision D-6): it was turned off
// after an accidental, unconfirmed destruction on 2026-09-12. An archive
// path is Post-MVP; the destroy primitives remain in machine-lifecycle.ts.
function deleteMission(_deps: MissionRouteDeps): RequestHandler {
	return async (_req, res) => {
		res.status(403).json({
			error:
				"Mission destruction is disabled; suspend the mission instead. An archive path is planned.",
		});
	};
}

export function registerMissionLifecycleRoutes(
	routes: AsyncRoutes,
	deps: MissionRouteDeps,
): void {
	routes.post("/", createMission(deps));
	routes.post("/draft", postDraft(deps));
	routes.post("/:id/suspend", postSuspend(deps));
	routes.post("/:id/resume", postResume(deps));
	routes.delete("/:id", deleteMission(deps));
}
