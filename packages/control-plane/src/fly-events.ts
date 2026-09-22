/**
 * OOM detection from Fly machine exit events (ADR-0032 Decision 2/4,
 * `oom-suspected`).
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

import {
	type AlertStateStore,
	createMongoAlertStateStore,
	createMongoAnomalyRecorder,
	createMongoMailboxRepository,
	MISSION_COPILOT_AGENT_ID,
} from "@magi/agent-runtime-worker";
import type { Db } from "mongodb";
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

interface MissionDocLike {
	missionId: string;
	userId: string;
}

/** Raises `oom-suspected` against the mission that owns `machineId`, if any is still on record. */
async function recordOomSuspected(
	db: Db,
	machineId: string,
	exitedAt: string,
): Promise<void> {
	const mission = await db
		.collection<MissionDocLike>("missions")
		.findOne({ machineId });
	if (!mission) {
		console.warn(
			`[fly-events] Suspected OOM on machine with no owning mission on record { machineId: "${machineId}" } — likely already destroyed/re-provisioned`,
		);
		return;
	}

	const copilotMissionId = `copilot-${mission.userId}`;
	await createMongoAnomalyRecorder(
		db,
		createMongoMailboxRepository(db, mission.missionId),
		MISSION_COPILOT_AGENT_ID,
		{
			mailboxRepo: createMongoMailboxRepository(db, copilotMissionId),
			missionId: copilotMissionId,
		},
	).record({
		missionId: mission.missionId,
		category: "oom-suspected",
		severity: "hard",
		message: `Machine ${machineId} exited in a way consistent with an out-of-memory kill at ${exitedAt}. If this repeats, consider a temporary memory upgrade (see the request-resources skill).`,
	});
}

export interface CheckOomExitsDeps {
	/** Injected for tests; defaults to the real Fly Machines API. */
	listMachinesFn?: () => Promise<FlyMachineSummary[]>;
	/** Injected for tests; defaults to a real Mongo-backed store. */
	dedupeStore?: AlertStateStore;
}

/**
 * Scans every machine's retained event history for suspected OOM exits,
 * dedupes against previously-seen ones, and raises `oom-suspected` for each
 * new one against its owning mission. Never throws — a failure here must not
 * break the resource-monitor tick.
 */
export async function checkOomExits(
	db: Db,
	deps: CheckOomExitsDeps = {},
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
			const key = `${machine.id}:oom-suspected:${exitedAt}`;
			try {
				if (await dedupeStore.get(key)) continue;
				await dedupeStore.put({ key, level: "hard", lastAlertAt: new Date() });
			} catch (e) {
				console.error(
					`[fly-events] Dedup store failed { key: "${key}", error: "${(e as Error).message}" } — proceeding without de-duplication`,
				);
			}
			await recordOomSuspected(db, machine.id, exitedAt).catch((e) => {
				console.error(
					`[fly-events] Failed to record oom-suspected { machineId: "${machine.id}", error: "${(e as Error).message}" }`,
				);
			});
		}
	}
}
