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
import {
	assertKnownModels,
	createMongoAnomalyRecorderForMission,
} from "@magi/agent-runtime-worker";
import type { RequestHandler } from "express";
import type { Collection, Db } from "mongodb";
import type { AsyncRoutes } from "./async-handler.js";
import {
	deleteMachine,
	isLocalExecution,
	provisionLocal,
	volumeExists,
} from "./fly-machines.js";
import { provisionTracked } from "./machine-lifecycle.js";
import {
	claimStatus,
	insertMissionOrConflict,
	runningPatch,
} from "./mission-claims.js";
import type { MissionRouteDeps } from "./mission-scope.js";
import { type MissionDoc, userFilter } from "./mission-scope.js";
import { suspendMissionMachine } from "./resource-upgrade.js";
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
			// Cloud: omit teamFiles from the machine env — daemon fetches from MongoDB.
			// Local: write to disk since the developer's daemon reads from the local path.
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
		if (!missionId || !name) {
			res.status(400).json({ error: "missionId and name are required" });
			return;
		}
		try {
			validateNewMissionId(missionId);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
			return;
		}

		const existing = await col.findOne({ missionId });
		if (existing) {
			res.status(409).json({ error: "Mission already exists" });
			return;
		}

		let mission: TeamConfig["mission"];
		let agents: AgentConfig[];
		let missionCopilotLimits: Limits | undefined;
		let teamFiles: Array<{ path: string; content: string }>;

		if (teamConfig) {
			const template = getTemplate(teamConfig);
			if (!template) {
				res.status(404).json({ error: `Unknown template "${teamConfig}"` });
				return;
			}
			mission = { ...template.config.mission, id: missionId, name };
			agents = template.config.agents;
			missionCopilotLimits = template.config.missionCopilotLimits;
			teamFiles = template.teamFiles;
		} else {
			mission = { id: missionId, name };
			agents = [];
			teamFiles = [];
		}

		const doc: MissionDoc = {
			missionId,
			userId: req.userId,
			name,
			teamConfig: teamConfig ?? "blank",
			mission: mission ? withDefaultSpendCap(mission) : mission,
			agents,
			missionCopilotLimits,
			teamFiles,
			maxCostCeilingUsd: platformMaxCostCeilingUsd(),
			status: "draft",
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		if (!(await insertMissionOrConflict(col, doc, res))) return;
		res.status(201).json(doc);
	};
}

// Suspend.
function postSuspend({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const mission = await col.findOne({
			missionId: req.params.id,
			...userFilter(req),
		});
		if (!mission?.machineId) {
			res.status(404).json({ error: "Not found or no machine" });
			return;
		}
		try {
			if (!mission.machineId.startsWith("local-")) {
				await suspendMissionMachine(db, {
					missionId: req.params.id,
					machineId: mission.machineId,
				});
			}
			await col.updateOne(
				{ missionId: req.params.id },
				{ $set: { status: "suspended", updatedAt: new Date() } },
			);
			res.json({ status: "suspended" });
		} catch (e) {
			console.error(
				`[missions] suspend failed { missionId: "${req.params.id}", error: "${(e as Error).message}" }`,
			);
			res.status(500).json({ error: (e as Error).message });
		}
	};
}

/**
 * Resume on Fly: delete the stopped machine and provision a fresh one against
 * the preserved workspace volume, so the new machine boots with the current
 * config from MongoDB (the Fly PATCH API for env updates on stopped machines
 * is unreliable). Throws, leaving the old machine untouched, when the volume
 * cannot be confirmed first.
 */
async function reprovisionOnVolume(
	db: Db,
	col: Collection<MissionDoc>,
	mission: MissionDoc,
	machineId: string,
): Promise<void> {
	// Resume on Fly: delete the stopped machine and provision a fresh one
	// against the preserved workspace volume. This guarantees the new machine
	// boots with the current config from MongoDB — the Fly PATCH API for
	// env-var updates on stopped machines is unreliable.
	if (!mission.volumeId) {
		throw new Error("No volume ID stored for this mission — cannot resume");
	}
	// Verify the volume actually exists BEFORE deleting the old (working)
	// machine. Without this check, a `mission.volumeId` that had drifted
	// wrong in MongoDB (found live, 2026-09-23) caused this handler to
	// destroy a healthy machine and then fail to re-create it — the real
	// data volume was untouched, but the mission was down until someone
	// noticed and fixed the record by hand. Failing here instead leaves
	// the working machine exactly as it was.
	if (!(await volumeExists(mission.volumeId))) {
		throw new Error(
			`Volume ${mission.volumeId} does not exist on Fly — mission.volumeId in MongoDB has likely drifted from the real volume. Not touching the current machine; check \`flyctl volumes list\` for the mission's actual volume before retrying.`,
		);
	}
	// Best-effort delete of the old machine. If it's already gone (deleted
	// outside MAGI), skip and proceed to provision.
	try {
		await deleteMachine(machineId);
		console.log(
			`[missions] deleted old machine ${machineId} before re-provision`,
		);
	} catch (e) {
		console.warn(
			`[missions] could not delete machine ${machineId}: ${(e as Error).message} — proceeding to provision anyway`,
		);
	}
	const handle = await provisionTracked(db, mission.missionId, {
		existingVolumeId: mission.volumeId,
		// teamFiles omitted: daemon fetches from missions collection at startup
		memoryMb: mission.mission?.memoryMb,
		cpus: mission.mission?.cpus,
	});
	await col.updateOne(
		{ missionId: mission.missionId },
		{
			$set: {
				machineId: handle.machineId,
				privateIp: handle.privateIp,
				status: "running",
				updatedAt: new Date(),
			},
			$unset: { errorMessage: "" },
		},
	);
}

// Resume — the daemon reads structured config directly from `missions` at boot (ADR-0021).
function postResume({ db, col }: MissionRouteDeps): RequestHandler {
	return async (req, res) => {
		const missionId = req.params.id;
		const mission = await col.findOne({
			missionId,
			...userFilter(req),
		});
		if (!mission?.machineId) {
			res.status(404).json({ error: "Not found or no machine" });
			return;
		}
		// Idempotency guard: without this, a duplicate/retried resume call (e.g.
		// a slow first request the operator gives up on and retries, or a
		// double-click) races with itself — the second call reads the mission
		// doc before the first call's $set lands, deletes the machine the first
		// call just created, and re-provisions again. Only a mission that isn't
		// already running or mid-provision can be (re-)resumed.
		if (mission.status === "running" || mission.status === "provisioning") {
			res.status(409).json({
				error: `Mission is already ${mission.status} — resume not needed`,
			});
			return;
		}
		if (!(await claimStatus(col, missionId, mission.status, "provisioning"))) {
			res.status(409).json({ error: "Mission is already being resumed" });
			return;
		}
		try {
			if (mission.machineId.startsWith("local-")) {
				// Nothing to re-write — the developer's restarted daemon reads
				// structured config directly from `missions` at boot (ADR-0021).
				await col.updateOne(
					{ missionId },
					{
						$set: { status: "running", updatedAt: new Date() },
						$unset: { errorMessage: "" },
					},
				);
			} else {
				await reprovisionOnVolume(db, col, mission, mission.machineId);
			}
			res.json({ status: "running" });
		} catch (e) {
			const errorMessage = (e as Error).message;
			console.error(
				`[missions] resume failed { missionId: "${missionId}", error: "${errorMessage}" }`,
			);
			// Surface the failure in Mongo, not just the HTTP response — without
			// this, a failed resume left the mission looking like an ordinary,
			// resumable "suspended" mission while actually pointing at a machine
			// that may already be deleted, with no visible explanation anywhere.
			await col.updateOne(
				{ missionId },
				{ $set: { status: "error", errorMessage, updatedAt: new Date() } },
			);
			// Wake the copilot the same way every other resource-oversight category
			// does (ADR-0032) — without this, a resume failure was only ever
			// discovered by someone happening to notice the mission's status
			// (found live, issue #62: a drifted volumeId went undetected on a
			// second mission until a proactive check, precisely because nothing
			// woke anyone). Covers any resume failure, not just a drifted volume.
			await createMongoAnomalyRecorderForMission(db, missionId, mission.userId)
				.record({
					missionId,
					category: "resume-failure",
					severity: "hard",
					message: errorMessage,
				})
				.catch((e) =>
					console.error(
						`[missions] Failed to record resume-failure anomaly { missionId: "${missionId}", error: "${(e as Error).message}" }`,
					),
				);
			res.status(500).json({ error: errorMessage });
		}
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
