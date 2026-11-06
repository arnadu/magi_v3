/**
 * The only place that provisions, stops, restarts or destroys a mission's Fly
 * machine, so every transition also opens or closes a runtime segment
 * (machine-segments.ts, ADR-0031 Decision 1). A unit test guards that no
 * other module imports the raw fly-machines lifecycle functions.
 *
 * Before any machine starts, the mission is given the default spend cap if it
 * has none (`ensureMissionSpendCap`, SCH-4) — not best-effort: a machine is
 * never started uncapped.
 *
 * Segment bookkeeping is best-effort: once the machine operation has
 * succeeded, failing the caller because a bookkeeping write failed would
 * orphan a machine that is really running, so a write failure is logged and
 * the periodic `reconcileSegments` corrects it.
 */

import { storedCollection } from "@magi/agent-config";
import { createMongoAnomalyRecorderForMission } from "@magi/agent-runtime-worker";
import type { Db } from "mongodb";
import {
	deleteMachine,
	destroyMission,
	FlyCapacityError,
	type MachineHandle,
	machineExists,
	type ProvisionOptions,
	provisionMission,
	resumeMission,
	suspendMission,
	updateMachine,
	volumeExists,
} from "./fly-machines.js";
import { forkVolume, waitForVolumeReady } from "./fly-volume-fork.js";
import {
	closeOpenSegments,
	defaultShapeOf,
	openSegment,
} from "./machine-segments.js";
import { DEFAULT_MACHINE, type MachineShape } from "./machine-shapes.js";
import { ensureMissionSpendCap } from "./spend-policy.js";

async function bestEffort(
	what: string,
	missionId: string,
	op: () => Promise<unknown>,
) {
	try {
		await op();
	} catch (e) {
		console.error(
			`[machine-lifecycle] Segment bookkeeping failed after ${what} { missionId: "${missionId}", error: "${(e as Error).message}" }`,
		);
	}
}

export interface ProvisionTracking {
	/** True when this machine is a temporary upgrade rather than the mission's default. */
	upgraded?: boolean;
	/** Planned end of the upgrade window. */
	plannedEndAt?: Date;
	requestedByAgentId?: string;
}

/** Provision a machine and open a segment for it. */
export async function provisionTracked(
	db: Db,
	missionId: string,
	opts: ProvisionOptions,
	tracking: ProvisionTracking = {},
): Promise<MachineHandle> {
	await ensureMissionSpendCap(db, missionId);
	const handle = await provisionMission(missionId, opts);
	const shape: MachineShape = {
		cpuKind: opts.cpuKind ?? DEFAULT_MACHINE.cpuKind,
		cpus: opts.cpus ?? DEFAULT_MACHINE.cpus,
		memoryMb: opts.memoryMb ?? DEFAULT_MACHINE.memoryMb,
	};
	await bestEffort("provision", missionId, () =>
		openSegment(db, {
			missionId,
			machineId: handle.machineId,
			shape,
			upgraded: tracking.upgraded ?? false,
			startedAt: new Date(),
			plannedEndAt: tracking.plannedEndAt,
			requestedByAgentId: tracking.requestedByAgentId,
		}),
	);
	return handle;
}

/** Stop the machine, then close the mission's open segment. */
export async function suspendTracked(
	db: Db,
	missionId: string,
	machineId: string,
): Promise<void> {
	await suspendMission(machineId);
	await bestEffort("suspend", missionId, () =>
		closeOpenSegments(db, missionId),
	);
}

/** Start the mission's stopped machine, then open a segment for it (a stopped machine is always the default shape). */
export async function resumeTracked(
	db: Db,
	mission: {
		missionId: string;
		machineId: string;
		mission?: { memoryMb?: number; cpus?: number };
	},
): Promise<void> {
	await ensureMissionSpendCap(db, mission.missionId);
	await resumeMission(mission.machineId);
	await bestEffort("resume", mission.missionId, () =>
		openSegment(db, {
			missionId: mission.missionId,
			machineId: mission.machineId,
			shape: defaultShapeOf(mission),
			upgraded: false,
			startedAt: new Date(),
		}),
	);
}

export interface WakeResult {
	/** False: the stopped machine was started. True: it was gone and a new one was provisioned on the volume. */
	reprovisioned: boolean;
	machineId: string;
}

/**
 * Bring a mission's machine back for a wake-up (a scheduled delivery, the
 * copilot's resume): a plain start when the stopped machine still exists,
 * otherwise a fresh provision against the mission's volume. The machine can
 * be gone for reasons the mission doc never saw — a resize that failed after
 * its delete step, or a machine removed outside MAGI (the Fly dashboard, a
 * quota clean-up: 2026-10-16, when every stopped machine in the app was
 * deleted by hand). The volume is the mission's state; the machine is
 * disposable. Either branch leaves the mission doc saying
 * "running" with the machine that is actually up, so both callers share one
 * piece of bookkeeping instead of each updating the doc differently.
 * "local-*" machines are the developer's own daemon: nothing to start.
 */
export async function wakeTracked(
	db: Db,
	mission: {
		missionId: string;
		machineId: string;
		volumeId?: string;
		mission?: { memoryMb?: number; cpus?: number };
	},
): Promise<WakeResult> {
	const { missionId, machineId } = mission;
	const missions = storedCollection(db, "missions");
	if (machineId.startsWith("local-")) {
		return { reprovisioned: false, machineId };
	}
	if (await machineExists(machineId)) {
		await resumeTracked(db, {
			missionId,
			machineId,
			mission: mission.mission,
		});
		await missions.updateOne(
			{ missionId },
			{ $set: { status: "running", updatedAt: new Date() } },
		);
		return { reprovisioned: false, machineId };
	}
	if (!mission.volumeId) {
		throw new Error(
			`Mission "${missionId}" has no machine on Fly (${machineId} is gone) and no volumeId to re-provision from`,
		);
	}
	if (!(await volumeExists(mission.volumeId))) {
		throw new Error(
			`Volume ${mission.volumeId} does not exist on Fly — mission.volumeId in MongoDB has likely drifted. Try ProposeAction "fix_mission_volume" first.`,
		);
	}
	const handle = await provisionOnVolumeTracked(db, {
		missionId,
		volumeId: mission.volumeId,
		mission: mission.mission,
	});
	await missions.updateOne(
		{ missionId },
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
	console.log(
		`[machine-lifecycle] wake re-provisioned { missionId: "${missionId}", goneMachineId: "${machineId}", machineId: "${handle.machineId}" }`,
	);
	return { reprovisioned: true, machineId: handle.machineId };
}

export interface RestartResult extends MachineHandle {
	/** "updated": the stopped machine took the new config in place; "recreated": a new machine on the same volume; "forked": a new machine on a fork of the volume, which is now the mission's `volumeId`. */
	how: "updated" | "recreated" | "forked";
}

interface MissionOnVolume {
	missionId: string;
	volumeId: string;
	mission?: { memoryMb?: number; cpus?: number };
}

/**
 * Bring a stopped mission back on the current image and config (an operator
 * resume). First choice is updating the stopped machine in place and starting
 * it, which keeps its place on the server that holds the volume. Deleting it
 * and creating a new one gives that place up, and a full server then strands
 * the mission (#103), so re-creating is only the fallback: when the machine is
 * gone, or the update or the start fails.
 */
export async function restartOnCurrentConfigTracked(
	db: Db,
	mission: MissionOnVolume & { machineId: string },
): Promise<RestartResult> {
	const { missionId, machineId, volumeId } = mission;
	try {
		const update = await updateMachine(
			machineId,
			missionId,
			volumeId,
			defaultShapeOf(mission),
		);
		if (update.updated) {
			await resumeTracked(db, {
				missionId,
				machineId,
				mission: mission.mission,
			});
			return {
				machineId,
				privateIp: update.privateIp,
				volumeId,
				how: "updated",
			};
		}
	} catch (e) {
		console.warn(
			`[machine-lifecycle] in-place restart failed { missionId: "${missionId}", machineId: "${machineId}", error: "${(e as Error).message}" } — re-creating the machine on its volume`,
		);
		try {
			await deleteMachine(machineId);
		} catch (del) {
			console.warn(
				`[machine-lifecycle] could not delete machine before re-creating it { missionId: "${missionId}", machineId: "${machineId}", error: "${(del as Error).message}" } — provisioning anyway`,
			);
		}
	}
	return provisionOnVolumeTracked(db, mission);
}

/**
 * Provision a machine on the mission's volume. When the volume's server is
 * full, fork the volume to another zone, point the mission at the fork
 * (compare-and-set, before waiting, so a timeout still leaves a resumable
 * mission), and provision there. The original volume is kept; a soft
 * `volume-forked` anomaly tells the copilot it can be deleted once the
 * mission is confirmed healthy.
 */
export async function provisionOnVolumeTracked(
	db: Db,
	mission: MissionOnVolume,
): Promise<RestartResult> {
	const { missionId, volumeId } = mission;
	const shape = defaultShapeOf(mission);
	const onVolume = (existingVolumeId: string) =>
		provisionTracked(db, missionId, {
			existingVolumeId,
			memoryMb: shape.memoryMb,
			cpus: shape.cpus,
		});
	try {
		return { ...(await onVolume(volumeId)), how: "recreated" };
	} catch (e) {
		if (!(e instanceof FlyCapacityError)) throw e;
		console.warn(
			`[machine-lifecycle] volume server full { missionId: "${missionId}", volumeId: "${volumeId}" } — forking the volume to another zone`,
		);
	}
	const fork = await forkVolume(missionId, volumeId, shape);
	const missions = storedCollection(db, "missions");
	const repoint = await missions.updateOne(
		{ missionId, volumeId },
		{ $set: { volumeId: fork.volumeId, updatedAt: new Date() } },
	);
	if (repoint.matchedCount !== 1) {
		throw new Error(
			`Mission "${missionId}" no longer records volume ${volumeId}; fork ${fork.volumeId} was created but not attached — check the mission's volumeId before deleting either`,
		);
	}
	const userId = (await missions.findOne({ missionId }))?.userId;
	if (userId) {
		await createMongoAnomalyRecorderForMission(db, missionId, userId)
			.record({
				missionId,
				category: "volume-forked",
				severity: "soft",
				message: `Volume ${volumeId}'s server had no room for the mission's machine, so the volume was forked to ${fork.volumeId}${fork.zone ? ` (zone ${fork.zone})` : ""} and the mission now uses the fork. ${volumeId} is unused and kept; delete it once the mission is confirmed healthy.`,
			})
			.catch((e) =>
				console.error(
					`[machine-lifecycle] Failed to record volume-forked anomaly { missionId: "${missionId}", error: "${(e as Error).message}" }`,
				),
			);
	}
	await waitForVolumeReady(fork.volumeId);
	return { ...(await onVolume(fork.volumeId)), how: "forked" };
}

/** Destroy the machine and volume, then close the mission's open segment. */
export async function destroyTracked(
	db: Db,
	missionId: string,
	machineId: string,
	volumeId: string,
): Promise<void> {
	await destroyMission(machineId, volumeId);
	await bestEffort("destroy", missionId, () =>
		closeOpenSegments(db, missionId),
	);
}

export type ResizeStage = "stop" | "delete" | "provision" | "record";

/**
 * A resize failed at `stage`. At "stop" nothing changed (the old machine is
 * still running); at "delete" or "provision" the old machine is gone, only
 * the volume remains, and the mission needs an operator Resume; at "record"
 * the new machine runs but the mission document could not be pointed at it
 * (the message names it).
 */
export class ResizeError extends Error {
	constructor(
		readonly stage: ResizeStage,
		message: string,
	) {
		super(message);
		this.name = "ResizeError";
	}
}

/**
 * Point the mission document at a freshly provisioned machine, right away
 * (RU5): until this lands the document names the deleted machine, so the
 * proxy, the monitor and every later resize act on a ghost. Retried, since
 * the machine is already running; on final failure the error names the
 * machine so it can be recorded by hand (or by reconcile --fix-status).
 */
async function recordMachine(
	db: Db,
	missionId: string,
	handle: MachineHandle,
): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await storedCollection(db, "missions").updateOne(
				{ missionId },
				{
					$set: {
						machineId: handle.machineId,
						privateIp: handle.privateIp,
						updatedAt: new Date(),
					},
				},
			);
			return;
		} catch (e) {
			lastError = e;
			await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
		}
	}
	throw new Error(
		`new machine ${handle.machineId} (${handle.privateIp}) is running but could not be recorded on the mission: ${(lastError as Error).message}`,
	);
}

/**
 * Replace a running mission's machine with one of a different shape on the
 * same volume: stop, delete, provision (the pattern the operator's resume
 * route already uses, since Fly cannot reliably resize in place), closing the
 * old runtime segment and opening one for the new machine. A hard stop, the
 * same as a manual suspend.
 */
export async function resizeTracked(
	db: Db,
	mission: { missionId: string; machineId: string; volumeId: string },
	shape: MachineShape,
	tracking: ProvisionTracking,
): Promise<MachineHandle> {
	const { missionId } = mission;
	const stage = async <T>(
		name: ResizeStage,
		op: () => Promise<T>,
	): Promise<T> => {
		try {
			return await op();
		} catch (e) {
			throw new ResizeError(name, (e as Error).message);
		}
	};

	await stage("stop", () => suspendMission(mission.machineId));
	await bestEffort("resize stop", missionId, () =>
		closeOpenSegments(db, missionId),
	);
	await stage("delete", () => deleteMachine(mission.machineId));
	const handle = await stage("provision", () =>
		provisionMission(missionId, {
			existingVolumeId: mission.volumeId,
			cpuKind: shape.cpuKind,
			cpus: shape.cpus,
			memoryMb: shape.memoryMb,
		}),
	);
	await stage("record", () => recordMachine(db, missionId, handle));
	await bestEffort("resize provision", missionId, () =>
		openSegment(db, {
			missionId,
			machineId: handle.machineId,
			shape,
			upgraded: tracking.upgraded ?? false,
			startedAt: new Date(),
			plannedEndAt: tracking.plannedEndAt,
			requestedByAgentId: tracking.requestedByAgentId,
		}),
	);
	return handle;
}
