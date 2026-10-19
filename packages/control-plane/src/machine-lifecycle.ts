/**
 * The only place that provisions, stops, restarts or destroys a mission's Fly
 * machine, so every transition also opens or closes a runtime segment
 * (machine-segments.ts, ADR-0031 Decision 1). A unit test guards that no
 * other module imports the raw fly-machines lifecycle functions.
 *
 * Segment bookkeeping is best-effort: once the machine operation has
 * succeeded, failing the caller because a bookkeeping write failed would
 * orphan a machine that is really running, so a write failure is logged and
 * the periodic `reconcileSegments` corrects it.
 */

import { storedCollection } from "@magi/agent-config";
import type { Db } from "mongodb";
import {
	deleteMachine,
	destroyMission,
	type MachineHandle,
	machineExists,
	type ProvisionOptions,
	provisionMission,
	resumeMission,
	suspendMission,
	volumeExists,
} from "./fly-machines.js";
import {
	closeOpenSegments,
	defaultShapeOf,
	openSegment,
} from "./machine-segments.js";
import { DEFAULT_MACHINE, type MachineShape } from "./machine-shapes.js";

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
 * disposable, and `POST /:id/resume` already deletes and re-creates it on
 * every operator resume. Either branch leaves the mission doc saying
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
	const handle = await provisionTracked(db, missionId, {
		existingVolumeId: mission.volumeId,
		memoryMb: mission.mission?.memoryMb,
		cpus: mission.mission?.cpus,
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

export type ResizeStage = "stop" | "delete" | "provision";

/**
 * A resize failed at `stage`. At "stop" nothing changed (the old machine is
 * still running); at "delete" or "provision" the old machine is gone, only
 * the volume remains, and the mission needs an operator Resume.
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
