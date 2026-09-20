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

import type { Db } from "mongodb";
import {
	deleteMachine,
	destroyMission,
	type MachineHandle,
	type ProvisionOptions,
	provisionMission,
	resumeMission,
	suspendMission,
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
