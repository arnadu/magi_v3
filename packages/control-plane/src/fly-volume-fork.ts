/**
 * Fork a mission's volume onto another Fly server (#103). A volume lives on
 * one physical server and a machine that mounts it must run there; when that
 * server is full (`volume_placement_capacity`) the only way to get the mission
 * running again is a copy of the volume somewhere with room. The fork keeps
 * the original's name, so `flyVolumeName()` still identifies the mission.
 */

import {
	appName,
	flyFetch,
	flyVolumeName,
	SNAPSHOT_RETENTION_DAYS,
} from "./fly-machines.js";
import type { MachineShape } from "./machine-shapes.js";

/** A fork copies the whole volume before it can be mounted; observed at 1–3 min for a 10 GB volume. */
export const FORK_READY_TIMEOUT_MS = 15 * 60_000;
const FORK_POLL_MS = 5_000;

interface FlyVolume {
	id: string;
	state: string;
	region: string;
	zone?: string;
}

async function getVolume(volumeId: string): Promise<FlyVolume> {
	const res = await flyFetch(`/apps/${appName()}/volumes/${volumeId}`);
	if (!res.ok) {
		throw new Error(
			`Failed to read volume ${volumeId}: ${res.status} ${await res.text()}`,
		);
	}
	return (await res.json()) as FlyVolume;
}

/**
 * Create a fork of `sourceVolumeId` in a different zone of the same region,
 * placed where a machine of `shape` fits. The source volume is left
 * untouched. The fork is not mountable until `waitForVolumeReady` returns.
 */
export async function forkVolume(
	missionId: string,
	sourceVolumeId: string,
	shape: MachineShape,
): Promise<{ volumeId: string; zone?: string }> {
	const source = await getVolume(sourceVolumeId);
	const res = await flyFetch(`/apps/${appName()}/volumes`, {
		method: "POST",
		body: JSON.stringify({
			name: flyVolumeName(missionId),
			region: source.region,
			source_volume_id: sourceVolumeId,
			require_unique_zone: true,
			snapshot_retention: SNAPSHOT_RETENTION_DAYS,
			compute: {
				cpu_kind: shape.cpuKind,
				cpus: shape.cpus,
				memory_mb: shape.memoryMb,
			},
		}),
	});
	if (!res.ok) {
		throw new Error(
			`Failed to fork volume ${sourceVolumeId}: ${res.status} ${await res.text()}`,
		);
	}
	const fork = (await res.json()) as FlyVolume;
	return { volumeId: fork.id, zone: fork.zone };
}

/** Wait until a (forked) volume reaches "created"; throws, naming it, after `timeoutMs`. */
export async function waitForVolumeReady(
	volumeId: string,
	timeoutMs = FORK_READY_TIMEOUT_MS,
	pollMs = FORK_POLL_MS,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const { state } = await getVolume(volumeId);
		if (state === "created") return;
		if (Date.now() >= deadline) {
			throw new Error(
				`Volume ${volumeId} is still "${state}" after ${Math.round(timeoutMs / 60_000)} min; resume again once it is "created"`,
			);
		}
		await new Promise((r) => setTimeout(r, pollMs));
	}
}
