/**
 * What a confirmed copilot action does: one handler per action type, looked
 * up by `executeAction` after the payload is re-validated against the same
 * registry that admitted it (copilot-actions.ts). A handler acts as the
 * user who owns the card.
 */

import {
	type AgentConfig,
	applyTeamConfigPatch,
	type Limits,
	type MissionDoc,
	parseTeamConfig,
	storedCollection,
	type TeamConfig,
	validateTeamFiles,
} from "@magi/agent-config";
import {
	assertKnownModels,
	createMongoMissionConfigWriter,
} from "@magi/agent-runtime-worker";
import type { Collection, Db } from "mongodb";
import {
	type ActionPayload,
	type ActionType,
	parseActionPayload,
} from "./copilot-actions.js";
import { executeLaunchMission } from "./copilot-launch-actions.js";
import {
	executeCancelSchedule,
	executeCreateSchedule,
} from "./copilot-schedule-actions.js";
import {
	flyVolumeName,
	isLocalExecution,
	listVolumes,
	provisionLocal,
} from "./fly-machines.js";
import {
	executeGithubIssueAction,
	GITHUB_ISSUE_ACTION,
	parseGithubIssuePayload,
} from "./github-issues.js";
import { provisionTracked, wakeTracked } from "./machine-lifecycle.js";
import { deriveMonitorToken } from "./monitor-token.js";
import type { PendingAction } from "./pending-actions.js";
import { suspendMissionMachine } from "./resource-upgrade.js";

interface ActionContext {
	db: Db;
	action: PendingAction;
	payload: Record<string, unknown>;
	userId: string;
	missions: Collection<MissionDoc>;
	now: Date;
}

const HANDLERS: Record<ActionType, (ctx: ActionContext) => Promise<string>> = {
	[GITHUB_ISSUE_ACTION]: (ctx) =>
		executeGithubIssueAction(parseGithubIssuePayload(ctx.payload), {
			userId: ctx.action.userId,
		}),
	launch_mission: (ctx) =>
		executeLaunchMission(
			ctx.db,
			ctx.payload as ActionPayload<"launch_mission">,
			ctx.userId,
			ctx.now,
		),
	launch_draft: launchDraft,
	suspend_mission: suspendMission,
	resume_mission: resumeMission,
	fix_mission_volume: fixMissionVolume,
	write_mission_file: writeMissionFile,
	save_session_config: saveSessionConfig,
	cancel_schedule: (ctx) =>
		executeCancelSchedule(
			ctx.db,
			ctx.payload as ActionPayload<"cancel_schedule">,
			ctx.userId,
		),
	create_schedule: (ctx) =>
		executeCreateSchedule(
			ctx.db,
			ctx.payload as ActionPayload<"create_schedule">,
			ctx.userId,
			ctx.now,
		),
	pause_agent: pauseOrResumeAgent,
	resume_agent: pauseOrResumeAgent,
	set_mission_budget: setMissionBudget,
};

export async function executeAction(
	db: Db,
	action: PendingAction,
	userId: string,
): Promise<string> {
	// Re-validated at execution against the same registry that admitted it at
	// proposal time: the card showed this payload, but nothing between the
	// store and here guarantees its shape, and a stale stored action should
	// fail loudly rather than run with missing fields.
	const parsed = parseActionPayload(action.type, action.payload);
	const handler = HANDLERS[parsed.type];
	if (!handler) throw new Error(`Unknown action type "${action.type}"`);
	return handler({
		db,
		action,
		payload: parsed.payload as Record<string, unknown>,
		userId,
		missions: storedCollection(db, "missions"),
		now: new Date(),
	});
}

async function launchDraft(ctx: ActionContext): Promise<string> {
	const { db, payload, userId, missions, now } = ctx;
	const missionId = payload.missionId as string;
	const draft = await missions.findOne({ missionId, userId });
	if (!draft) throw new Error(`Mission "${missionId}" not found`);
	if (draft.status !== "draft")
		throw new Error(`Mission "${missionId}" is not a draft`);

	let validated: TeamConfig;
	try {
		validated = parseTeamConfig({
			mission: draft.mission,
			agents: draft.agents,
			missionCopilotLimits: draft.missionCopilotLimits,
		});
		assertKnownModels(validated.mission);
	} catch (e) {
		throw new Error(`Invalid team config: ${(e as Error).message}`);
	}

	try {
		const handle = isLocalExecution()
			? provisionLocal(missionId, { teamFiles: draft.teamFiles ?? [] })
			: await provisionTracked(db, missionId, {
					memoryMb: validated.mission.memoryMb,
					cpus: validated.mission.cpus,
				});
		await missions.updateOne(
			{ missionId },
			{
				$set: {
					machineId: handle.machineId,
					privateIp: handle.privateIp,
					volumeId: handle.volumeId,
					status: "running",
					updatedAt: now,
				},
			},
		);
		return `Mission "${missionId}" launched (machine: ${handle.machineId})`;
	} catch (e) {
		const errorMessage = (e as Error).message;
		console.error(
			`[copilot-router] draft launch failed { missionId: "${missionId}", error: "${errorMessage}" }`,
		);
		await missions.updateOne(
			{ missionId },
			{ $set: { status: "error", errorMessage, updatedAt: now } },
		);
		throw new Error(
			`Launch failed for mission "${missionId}": ${errorMessage}`,
		);
	}
}

async function suspendMission(ctx: ActionContext): Promise<string> {
	const { db, payload, userId, missions, now } = ctx;
	const missionId = payload.missionId as string;
	const mission = await missions.findOne({ missionId, userId });
	if (!mission?.machineId)
		throw new Error(`Mission "${missionId}" has no machine`);
	await suspendMissionMachine(db, {
		missionId,
		machineId: mission.machineId,
	});
	await missions.updateOne(
		{ missionId },
		{ $set: { status: "suspended", updatedAt: now } },
	);
	return `Mission "${missionId}" suspended`;
}

async function resumeMission(ctx: ActionContext): Promise<string> {
	const { db, payload, userId, missions } = ctx;
	const missionId = payload.missionId as string;
	const mission = await missions.findOne({ missionId, userId });
	if (!mission?.machineId)
		throw new Error(`Mission "${missionId}" has no machine`);

	// A mission left in "error" status (e.g. after a resume that failed
	// because its volumeId had drifted — issue #62) has no guarantee its
	// machineId still points to a real Fly machine; wakeTracked starts it
	// when it exists and re-provisions on the volume when it is gone —
	// without that, this action could never recover a mission
	// fix_mission_volume just fixed, since its old machineId is exactly
	// the one that got deleted.
	const woke = await wakeTracked(db, {
		missionId,
		machineId: mission.machineId,
		volumeId: mission.volumeId,
		mission: mission.mission,
	});
	return woke.reprovisioned
		? `Mission "${missionId}" resumed (its machine had been destroyed — reprovisioned fresh: ${woke.machineId})`
		: `Mission "${missionId}" resumed`;
}

async function fixMissionVolume(ctx: ActionContext): Promise<string> {
	const { payload, userId, missions, now } = ctx;
	const missionId = payload.missionId as string;
	const mission = await missions.findOne({ missionId, userId });
	if (!mission) throw new Error(`Mission "${missionId}" not found`);

	// The candidate is derived server-side from Fly's own volume list and
	// the existing naming convention (flyVolumeName) — the LLM never
	// supplies a volume ID directly. Letting it do so would let a
	// compromised or confused copilot attach any mission's volume to any
	// other mission, a cross-tenant risk. Refusing on ambiguity (rather
	// than guessing) keeps this to "fix the one case we can verify."
	const expectedName = flyVolumeName(missionId);
	const [allVolumes, otherMissions] = await Promise.all([
		listVolumes(),
		missions
			.find({ missionId: { $ne: missionId }, status: { $ne: "destroyed" } })
			.toArray(),
	]);
	const claimedElsewhere = new Set(
		otherMissions.map((m) => m.volumeId).filter((id): id is string => !!id),
	);
	const candidates = allVolumes.filter(
		(v) => v.name === expectedName && !claimedElsewhere.has(v.id),
	);

	if (candidates.length === 0) {
		throw new Error(
			`No unclaimed Fly volume named "${expectedName}" found for mission "${missionId}" — check \`flyctl volumes list\` manually.`,
		);
	}
	if (candidates.length > 1) {
		throw new Error(
			`Ambiguous: ${candidates.length} unclaimed Fly volumes named "${expectedName}" found (ids: ${candidates.map((c) => c.id).join(", ")}) — resolve manually via \`flyctl volumes list\`.`,
		);
	}

	const [volume] = candidates;
	await missions.updateOne(
		{ missionId },
		{ $set: { volumeId: volume.id, updatedAt: now } },
	);
	return `mission.volumeId for "${missionId}" corrected to ${volume.id} (matched by name "${expectedName}"). Propose "resume_mission" next to bring the mission back up.`;
}

async function writeMissionFile(ctx: ActionContext): Promise<string> {
	const { payload, userId, missions } = ctx;
	const missionId = payload.missionId as string;
	const path = payload.path as string;
	const content = payload.content as string;
	const agentId = payload.agentId as string | undefined;

	const mission = await missions.findOne({ missionId, userId });
	if (!mission?.privateIp)
		throw new Error(`Mission "${missionId}" has no private IP`);

	const endpoint = agentId
		? `/files/workdir/${encodeURIComponent(agentId)}/write`
		: "/files/shared/write";

	const monitorToken = deriveMonitorToken(missionId);
	const res = await fetch(`http://[${mission.privateIp}]:4000${endpoint}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(monitorToken ? { "x-monitor-token": monitorToken } : {}),
		},
		body: JSON.stringify({ path, content }),
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`Write failed: ${res.status}`);
	return `File "${path}" written to mission "${missionId}"`;
}

async function saveSessionConfig(ctx: ActionContext): Promise<string> {
	const { db, payload, userId, missions, now } = ctx;
	const scMissionId = payload.missionId as string | undefined;
	const scMissionPatch = payload.mission as
		| Partial<TeamConfig["mission"]>
		| undefined;
	const scAgentsPatch = payload.agents as AgentConfig[] | undefined;
	const scMissionCopilotLimitsPatch = payload.missionCopilotLimits as
		| Limits
		| undefined;
	const scTeamFilesProvided = payload.teamFiles !== undefined;
	const scFiles =
		(payload.teamFiles as
			| Array<{ path: string; content: string }>
			| undefined) ?? [];
	const scMentalMaps = payload.mentalMaps as Record<string, string> | undefined;

	if (!scMissionId) {
		throw new Error("save_session_config: missionId is required");
	}
	const scMission = await missions.findOne({
		missionId: scMissionId,
		userId,
	});
	if (!scMission) throw new Error(`Mission ${scMissionId} not found`);
	if (scMission.status !== "suspended") {
		throw new Error(
			`Mission ${scMissionId} must be suspended before editing config (current: ${scMission.status})`,
		);
	}
	if (!scMission.mission || !scMission.agents) {
		throw new Error(`Mission ${scMissionId} has no structured config stored`);
	}

	let scValidated: TeamConfig;
	try {
		scValidated = applyTeamConfigPatch(
			{ ...scMission, mission: scMission.mission, agents: scMission.agents },
			scMissionId,
			{
				mission: scMissionPatch,
				agents: scAgentsPatch,
				missionCopilotLimits: scMissionCopilotLimitsPatch,
			},
		);
		assertKnownModels(scValidated.mission);
	} catch (e) {
		throw new Error(`Invalid team config: ${(e as Error).message}`);
	}
	// TF1/CHAIN-A: scFiles is copilot/LLM-authored and reaches the
	// daemon's filesystem unvalidated otherwise (team-files-sync.ts).
	if (scTeamFilesProvided) validateTeamFiles(scFiles);

	await createMongoMissionConfigWriter(db).write(
		scMissionId,
		{
			mission: scValidated.mission,
			agents: scValidated.agents,
			missionCopilotLimits: scValidated.missionCopilotLimits,
		},
		"copilot",
	);
	if (scTeamFilesProvided) {
		await missions.updateOne(
			{ missionId: scMissionId },
			{ $set: { teamFiles: scFiles, updatedAt: now } },
		);
	}
	if (scMentalMaps) {
		const convCol = storedCollection(db, "conversationMessages");
		for (const [agentId, html] of Object.entries(scMentalMaps)) {
			const latest = await convCol.findOne(
				{
					agentId,
					missionId: scMissionId,
					mentalMapHtml: { $exists: true },
				},
				{ sort: { turnNumber: -1, seqInTurn: -1 } },
			);
			if (latest) {
				await convCol.updateOne(
					{ _id: latest._id },
					{ $set: { mentalMapHtml: html } },
				);
			}
		}
	}
	return `Session config saved for mission ${scMissionId}`;
}

async function pauseOrResumeAgent(ctx: ActionContext): Promise<string> {
	const { payload, userId, missions, action } = ctx;
	const missionId = payload.missionId as string;
	const agentId = payload.agentId as string;
	const endpoint =
		action.type === "pause_agent" ? "/pause-agent" : "/resume-agent";
	await postToMissionMonitor(missions, userId, missionId, endpoint, {
		agentId,
	});
	const verb = action.type === "pause_agent" ? "paused" : "resumed";
	return `Agent "${agentId}" ${verb} in mission "${missionId}"`;
}

async function setMissionBudget(ctx: ActionContext): Promise<string> {
	const { payload, userId, missions } = ctx;
	const missionId = payload.missionId as string;
	const capUsd = payload.capUsd as number;
	if (typeof capUsd !== "number" || capUsd <= 0) {
		throw new Error("set_mission_budget requires a positive capUsd");
	}
	await postToMissionMonitor(missions, userId, missionId, "/set-budget", {
		capUsd,
	});
	return `Mission "${missionId}" spending cap set to $${capUsd.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * POST a JSON body to a mutating endpoint on a mission's execution-plane monitor
 * server (port 4000), scoped to the requesting user and authenticated with the
 * per-mission monitor token. Throws if the mission is unknown to the user, has
 * no private IP (not running), or the monitor returns non-2xx.
 */
async function postToMissionMonitor(
	missions: Collection<MissionDoc>,
	userId: string,
	missionId: string,
	endpoint: string,
	body: unknown,
): Promise<void> {
	const mission = await missions.findOne({ missionId, userId });
	if (!mission?.privateIp) {
		throw new Error(
			`Mission "${missionId}" is not running (no private IP) — cannot ${endpoint}`,
		);
	}
	const token = deriveMonitorToken(missionId);
	const res = await fetch(`http://[${mission.privateIp}]:4000${endpoint}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { "x-monitor-token": token } : {}),
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) {
		throw new Error(`Monitor ${endpoint} failed: HTTP ${res.status}`);
	}
}
