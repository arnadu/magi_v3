/**
 * Machine exits worth an alert, from Fly machine exit events: a suspected
 * out-of-memory kill (ADR-0032 Decision 2/4, `oom-suspected`), and a running
 * mission whose machine stopped after a crash that Fly will not restart
 * (`machine-down`: a daemon failing at boot exits, is restarted three times,
 * and stays stopped while the mission still reads `running`).
 *
 * Fly retains only ~5 events per machine, so this must run often enough
 * (the 5-min resource-monitor tick) not to miss a kill between samples.
 * There is no dedicated "OOM" event — an OOM-killed machine exits like any
 * other crash, so this is inference from the exit signal, not a certainty
 * (hence "suspected"). A machine stopped by ADR-0031's own resize/suspend
 * flow sets `requested_stop`, which is never classified as OOM.
 *
 * Dedup reuses `AlertStateStore` as a plain existence check keyed on
 * `${machineId}:oom-suspected:${exitedAt}` — this is a discrete one-time
 * event, not a continuous ratio, so `evaluateAlert`'s hysteresis doesn't
 * apply; the key's timestamp alone prevents the same exit being reported
 * twice across ticks.
 */

import { storedCollection } from "@magi/agent-config";
import {
	type AlertStateStore,
	createMongoAlertStateStore,
	createMongoAnomalyRecorderForMission,
} from "@magi/agent-runtime-worker";
import type { Db } from "mongodb";
import {
	describeLastExit,
	isCrashStopped,
	lastExit,
} from "./fly-machine-diagnostics.js";
import type { FlyMachineEvent, FlyMachineSummary } from "./fly-machines.js";
import { listMachines } from "./fly-machines.js";

const OOM_EXIT_CODE = 137;
const OOM_SIGNAL = 9;

export type ExitClassification = "requested-stop" | "oom-suspected" | "other";

/** Classifies one exit event; null for anything that isn't an exit event at all. */
export function classifyExit(
	event: FlyMachineEvent,
): ExitClassification | null {
	if (event.type !== "exit") return null;
	const exitEvent = event.request?.exit_event;
	if (!exitEvent) return null;
	if (exitEvent.requested_stop) return "requested-stop";
	if (
		exitEvent.oom_killed === true ||
		exitEvent.signal === OOM_SIGNAL ||
		exitEvent.guest_signal === OOM_SIGNAL ||
		exitEvent.exit_code === OOM_EXIT_CODE
	) {
		return "oom-suspected";
	}
	return "other";
}

/** Raises `oom-suspected` against the mission that owns `machineId`, if any is still on record. */
async function recordOomSuspected(
	db: Db,
	machineId: string,
	exitedAt: string,
): Promise<void> {
	const mission = await storedCollection(db, "missions").findOne({ machineId });
	if (!mission) {
		console.warn(
			`[fly-events] Suspected OOM on machine with no owning mission on record { machineId: "${machineId}" } — likely already destroyed/re-provisioned`,
		);
		return;
	}

	await createMongoAnomalyRecorderForMission(
		db,
		mission.missionId,
		mission.userId,
	).record({
		missionId: mission.missionId,
		category: "oom-suspected",
		severity: "hard",
		message: `Machine ${machineId} exited in a way consistent with an out-of-memory kill at ${exitedAt}. If this repeats, consider a temporary memory upgrade (see the request-resources skill).`,
	});
}

/** Raises `machine-down` when the stopped machine belongs to a mission that is meant to be running. */
async function recordMachineDown(
	db: Db,
	machine: FlyMachineSummary,
): Promise<void> {
	const mission = await storedCollection(db, "missions").findOne({
		machineId: machine.id,
		status: "running",
	});
	if (!mission) return;
	await createMongoAnomalyRecorderForMission(
		db,
		mission.missionId,
		mission.userId,
	).record({
		missionId: mission.missionId,
		category: "machine-down",
		severity: "hard",
		message: `Mission "${mission.missionId}" is running, but its machine ${machine.id} is stopped and will not restart by itself. Last exit, from Fly: ${describeLastExit(machine)}. Nothing in the mission runs until it is resumed, and resuming repeats the failure unless its cause is fixed.`,
	});
}

export interface CheckMachineExitsDeps {
	/** Injected for tests; defaults to the real Fly Machines API. */
	listMachinesFn?: () => Promise<FlyMachineSummary[]>;
	/** Injected for tests; defaults to a real Mongo-backed store. */
	dedupeStore?: AlertStateStore;
}

/** Exits reported while the dedupe store was failing; process-local (a restart may report one again). */
const reportedWhileStoreDown = new Set<string>();

/** True the first time `key` is seen; the store failing falls back to memory (FE1). */
async function firstReport(
	dedupeStore: AlertStateStore,
	key: string,
): Promise<boolean> {
	try {
		if (await dedupeStore.get(key)) return false;
		await dedupeStore.put({ key, level: "hard", lastAlertAt: new Date() });
		return true;
	} catch (e) {
		// FE1: still report a new exit, but not the same one on every tick
		// for as long as the store is down.
		if (reportedWhileStoreDown.has(key)) return false;
		reportedWhileStoreDown.add(key);
		console.error(
			`[fly-events] Dedup store failed { key: "${key}", error: "${(e as Error).message}" } — de-duplicating in memory until it recovers`,
		);
		return true;
	}
}

/**
 * Scans every machine's retained event history for suspected OOM exits and
 * for machines stopped after a crash, dedupes each against previously-seen
 * exits, and raises `oom-suspected` / `machine-down` against the owning
 * mission. Never throws — a failure here must not break the resource-monitor
 * tick.
 */
export async function checkMachineExits(
	db: Db,
	deps: CheckMachineExitsDeps = {},
): Promise<void> {
	const listMachinesFn = deps.listMachinesFn ?? listMachines;
	const dedupeStore = deps.dedupeStore ?? createMongoAlertStateStore(db);

	let machines: FlyMachineSummary[];
	try {
		machines = await listMachinesFn();
	} catch (e) {
		console.error(
			`[fly-events] Failed to list machines: ${(e as Error).message}`,
		);
		return;
	}

	for (const machine of machines) {
		for (const event of machine.events ?? []) {
			if (classifyExit(event) !== "oom-suspected") continue;
			const exitedAt = event.request?.exit_event?.exited_at;
			if (!exitedAt) {
				// Can't build a stable dedup key without a timestamp — skip rather
				// than risk re-reporting the same exit on every tick.
				continue;
			}
			if (
				!(await firstReport(
					dedupeStore,
					`${machine.id}:oom-suspected:${exitedAt}`,
				))
			)
				continue;
			await recordOomSuspected(db, machine.id, exitedAt).catch((e) => {
				console.error(
					`[fly-events] Failed to record oom-suspected { machineId: "${machine.id}", error: "${(e as Error).message}" }`,
				);
			});
		}

		if (!isCrashStopped(machine)) continue;
		const exitedAt = lastExit(machine.events)?.exitedAt;
		if (
			!(await firstReport(
				dedupeStore,
				`${machine.id}:machine-down:${exitedAt}`,
			))
		)
			continue;
		await recordMachineDown(db, machine).catch((e) => {
			console.error(
				`[fly-events] Failed to record machine-down { machineId: "${machine.id}", error: "${(e as Error).message}" } — the operator will not be told the machine is down`,
			);
		});
	}
}
