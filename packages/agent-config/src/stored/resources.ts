/**
 * Resource oversight documents (ADR-0032).
 *
 * `missionResources`: the daemon's latest disk/memory/job sample, one per
 * mission, upserted every minute; read by the control plane's monitor tick
 * and daily report.
 *
 * `platformResources`: cluster-wide samples written by the control plane,
 * one document per kind, keyed by `_id`.
 */

export interface MissionResourceSample {
	missionId: string;
	diskUsedBytes: number;
	diskTotalBytes: number;
	rssMb: number;
	runningJobs: number;
	updatedAt: Date;
}

/** Shared MongoDB Atlas storage, from the 5-minute resource-monitor tick. */
export interface AtlasUsageDoc {
	_id: "atlas";
	usedBytes: number;
	limitBytes: number;
	databases: Array<{ name: string; bytes: number }>;
	collections: Array<{ name: string; bytes: number }>;
	updatedAt: Date;
}

/** A Fly machine no mission references. */
export interface OrphanMachine {
	id: string;
	name?: string;
	state?: string;
	/** `MISSION_ID` from the machine's env, when provisioning set one: which mission leaked it. */
	missionIdEnv?: string;
	createdAt?: string;
}

/** Fly machines not referenced by any mission, and which of them were already reported. */
export interface FlyMachinesSampleDoc {
	_id: "fly-machines";
	total: number;
	referenced: number;
	orphans: OrphanMachine[];
	alertedOrphanIds: string[];
	updatedAt: Date;
}

export type PlatformResourcesDoc = AtlasUsageDoc | FlyMachinesSampleDoc;
