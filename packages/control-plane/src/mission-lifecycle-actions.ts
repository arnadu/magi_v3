/**
 * Suspend and resume a mission: the one implementation behind the cockpit's
 * routes (`POST /:id/suspend|resume`) and the control-plane copilot's
 * `suspend_mission`/`resume_mission` actions. Both are the operator's own
 * decision, so they must do the same thing. They used to be separate code:
 * the copilot's resume was built on the scheduler's wake path, took a
 * destroyed machine for a stopped one, and failed for 7 h on a mission the
 * cockpit route recovered at once (ai-news-digest, 2026-11-13).
 *
 * The scheduler's wake (`wakeTracked`) stays separate on purpose: a
 * scheduled wake-up starts the mission's machine as it is, without moving a
 * running mission to a new image or config.
 */

import { createMongoAnomalyRecorderForMission } from "@magi/agent-runtime-worker";
import type { Collection, Db } from "mongodb";
import { volumeExists } from "./fly-machines.js";
import { restartOnCurrentConfigTracked } from "./machine-lifecycle.js";
import { claimStatus } from "./mission-claims.js";
import type { MissionDoc } from "./mission-scope.js";
import { suspendMissionMachine } from "./resource-upgrade.js";

export type LifecycleResult =
	| { ok: true; message: string }
	| { ok: false; status: 404 | 409 | 500; error: string };

const refused = (status: 404 | 409 | 500, error: string): LifecycleResult => ({
	ok: false,
	status,
	error,
});

export async function suspendMission(
	db: Db,
	col: Collection<MissionDoc>,
	mission: MissionDoc | null,
): Promise<LifecycleResult> {
	if (!mission?.machineId) return refused(404, "Not found or no machine");
	const { missionId, machineId } = mission;
	try {
		if (!machineId.startsWith("local-")) {
			await suspendMissionMachine(db, { missionId, machineId });
		}
		await col.updateOne(
			{ missionId },
			{ $set: { status: "suspended", updatedAt: new Date() } },
		);
		return { ok: true, message: `Mission "${missionId}" suspended` };
	} catch (e) {
		const error = (e as Error).message;
		console.error(
			`[missions] suspend failed { missionId: "${missionId}", error: "${error}" }`,
		);
		return refused(500, error);
	}
}

/**
 * Resume on the current image and config, on the mission's volume. Works
 * from `suspended` and from `error` (a failed resume or resize): the stopped
 * machine is updated in place, or re-created on the volume when it is gone,
 * or on a fork of the volume when its server is full. A failure leaves the
 * mission in `error` and raises a hard `resume-failure` anomaly.
 */
export async function resumeMission(
	db: Db,
	col: Collection<MissionDoc>,
	mission: MissionDoc | null,
): Promise<LifecycleResult> {
	if (!mission?.machineId) return refused(404, "Not found or no machine");
	const { missionId, machineId } = mission;
	// Idempotency guard: a retried or double-clicked resume reading the doc
	// before the first one's write lands would delete the machine the first
	// one just created and provision again.
	if (mission.status === "running" || mission.status === "provisioning") {
		return refused(
			409,
			`Mission is already ${mission.status} — resume not needed`,
		);
	}
	if (!(await claimStatus(col, missionId, mission.status, "provisioning"))) {
		return refused(409, "Mission is already being resumed");
	}
	try {
		if (machineId.startsWith("local-")) {
			// The developer's restarted daemon reads its config from `missions` at boot.
			await col.updateOne(
				{ missionId },
				{
					$set: { status: "running", updatedAt: new Date() },
					$unset: { errorMessage: "" },
				},
			);
			return { ok: true, message: `Mission "${missionId}" resumed` };
		}
		const how = await restartOnVolume(db, col, mission, machineId);
		return { ok: true, message: `Mission "${missionId}" resumed (${how})` };
	} catch (e) {
		const error = (e as Error).message;
		await recordResumeFailure(db, col, mission, error);
		return refused(500, error);
	}
}

async function restartOnVolume(
	db: Db,
	col: Collection<MissionDoc>,
	mission: MissionDoc,
	machineId: string,
): Promise<string> {
	if (!mission.volumeId) {
		throw new Error("No volume ID stored for this mission — cannot resume");
	}
	// A drifted `mission.volumeId` (#62) once got a healthy machine deleted
	// and never re-created: check the volume before touching the machine.
	if (!(await volumeExists(mission.volumeId))) {
		throw new Error(
			`Volume ${mission.volumeId} does not exist on Fly — mission.volumeId in MongoDB has likely drifted from the real volume. Not touching the current machine; check \`flyctl volumes list\` for the mission's actual volume before retrying.`,
		);
	}
	const handle = await restartOnCurrentConfigTracked(db, {
		missionId: mission.missionId,
		machineId,
		volumeId: mission.volumeId,
		mission: mission.mission,
	});
	console.log(
		`[missions] resumed { missionId: "${mission.missionId}", how: "${handle.how}", machineId: "${handle.machineId}", volumeId: "${handle.volumeId}" }`,
	);
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
	return handle.how;
}

/**
 * A failed resume is visible in the mission (status `error` with the reason)
 * and wakes the copilots (#62: a drifted volume once went unnoticed because
 * nothing did).
 */
async function recordResumeFailure(
	db: Db,
	col: Collection<MissionDoc>,
	mission: MissionDoc,
	errorMessage: string,
): Promise<void> {
	const { missionId } = mission;
	console.error(
		`[missions] resume failed { missionId: "${missionId}", error: "${errorMessage}" }`,
	);
	await col.updateOne(
		{ missionId },
		{ $set: { status: "error", errorMessage, updatedAt: new Date() } },
	);
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
}
