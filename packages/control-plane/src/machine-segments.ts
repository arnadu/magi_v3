/**
 * Machine-config runtime segments (ADR-0031 Decision 1): one document per
 * stretch of time a mission's machine ran with one shape. This is the single
 * source for the runtime-by-config cockpit tab and for the cumulative
 * upgraded-runtime cap (Decision 7). Deliberately separate from LLM cost
 * accounting.
 *
 * At most one segment per mission is open (`endedAt` absent). Segments are
 * written at each lifecycle transition by machine-lifecycle.ts and corrected
 * against live Fly state by `reconcileSegments`, so a machine that Fly stopped
 * on its own does not keep accruing runtime.
 */

import type { Db } from "mongodb";
import {
	DEFAULT_MACHINE,
	type MachineShape,
	sameShape,
} from "./machine-shapes.js";

export interface MachineSegment {
	missionId: string;
	machineId?: string;
	shape: MachineShape;
	/** True when `shape` differs from the mission's default machine at the time. */
	upgraded: boolean;
	startedAt: Date;
	endedAt?: Date;
	/** Planned end of an upgrade window; while the segment is open it counts toward the cap up to here. */
	plannedEndAt?: Date;
	requestedByAgentId?: string;
}

const COLLECTION = "machineSegments";
const indexed = new WeakSet<Db>();

function collection(db: Db) {
	const col = db.collection<MachineSegment>(COLLECTION);
	if (!indexed.has(db)) {
		indexed.add(db);
		col
			.createIndex({ missionId: 1, startedAt: 1 })
			.catch((e: unknown) =>
				console.warn(
					"[machine-segments] Failed to create index:",
					(e as Error).message,
				),
			);
	}
	return col;
}

/** The machine a mission runs on when not upgraded: shared CPU, sized by `mission.memoryMb`/`cpus`. */
export function defaultShapeOf(mission: {
	mission?: { memoryMb?: number; cpus?: number };
}): MachineShape {
	return {
		cpuKind: DEFAULT_MACHINE.cpuKind,
		cpus: mission.mission?.cpus ?? DEFAULT_MACHINE.cpus,
		memoryMb: mission.mission?.memoryMb ?? DEFAULT_MACHINE.memoryMb,
	};
}

// ---------------------------------------------------------------------------
// Pure summaries
// ---------------------------------------------------------------------------

/** Milliseconds a segment overlaps [from, to]. */
function overlapMs(start: Date, end: Date, from: Date, to: Date): number {
	const lo = Math.max(start.getTime(), from.getTime());
	const hi = Math.min(end.getTime(), to.getTime());
	return Math.max(0, hi - lo);
}

/**
 * Total time on non-default machines since `since`.
 *
 * `elapsed` counts an open segment up to `now` (for display). `committed`
 * counts an open segment to the end of its planned window, if that is still
 * ahead, so a request that would take the total past the cap is refused up
 * front and an upgrade can never run past it.
 */
export function upgradedMs(
	segments: readonly MachineSegment[],
	opts: { since: Date; now: Date; mode: "elapsed" | "committed" },
): number {
	const { since, now, mode } = opts;
	let total = 0;
	for (const seg of segments) {
		if (!seg.upgraded) continue;
		let end: Date;
		let until: Date;
		if (seg.endedAt) {
			end = seg.endedAt;
			until = now;
		} else if (mode === "committed") {
			end = seg.plannedEndAt && seg.plannedEndAt > now ? seg.plannedEndAt : now;
			until = end;
		} else {
			end = now;
			until = now;
		}
		total += overlapMs(seg.startedAt, end, since, until);
	}
	return total;
}

export interface RuntimeByConfig {
	shape: MachineShape;
	upgraded: boolean;
	ms: number;
}

/** Runtime since `since`, grouped by machine shape (open segments count to `now`). */
export function runtimeByConfig(
	segments: readonly MachineSegment[],
	opts: { since: Date; now: Date },
): RuntimeByConfig[] {
	const groups = new Map<string, RuntimeByConfig>();
	for (const seg of segments) {
		const ms = overlapMs(
			seg.startedAt,
			seg.endedAt ?? opts.now,
			opts.since,
			opts.now,
		);
		if (ms === 0) continue;
		const key = `${seg.shape.cpuKind}/${seg.shape.cpus}/${seg.shape.memoryMb}`;
		const group = groups.get(key) ?? {
			shape: seg.shape,
			upgraded: seg.upgraded,
			ms: 0,
		};
		group.ms += ms;
		groups.set(key, group);
	}
	return [...groups.values()].sort((a, b) => b.ms - a.ms);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Start a segment, closing any still-open one for the mission first so at most one is ever open. */
export async function openSegment(
	db: Db,
	segment: Omit<MachineSegment, "endedAt">,
): Promise<void> {
	const col = collection(db);
	await col.updateMany(
		{ missionId: segment.missionId, endedAt: { $exists: false } },
		{ $set: { endedAt: segment.startedAt } },
	);
	// The driver would store `undefined` fields as null; keep the document clean.
	const doc: MachineSegment = {
		missionId: segment.missionId,
		shape: segment.shape,
		upgraded: segment.upgraded,
		startedAt: segment.startedAt,
		...(segment.machineId !== undefined && { machineId: segment.machineId }),
		...(segment.plannedEndAt !== undefined && {
			plannedEndAt: segment.plannedEndAt,
		}),
		...(segment.requestedByAgentId !== undefined && {
			requestedByAgentId: segment.requestedByAgentId,
		}),
	};
	await col.insertOne(doc);
}

/** Close the mission's open segment, if any. Returns how many were closed. */
export async function closeOpenSegments(
	db: Db,
	missionId: string,
	at: Date = new Date(),
): Promise<number> {
	const r = await collection(db).updateMany(
		{ missionId, endedAt: { $exists: false } },
		{ $set: { endedAt: at } },
	);
	return r.modifiedCount;
}

/** Move the planned end of the mission's open upgrade segment (renewal). */
export async function setPlannedEnd(
	db: Db,
	missionId: string,
	plannedEndAt: Date,
): Promise<void> {
	await collection(db).updateOne(
		{ missionId, endedAt: { $exists: false } },
		{ $set: { plannedEndAt } },
	);
}

/** The mission's currently-open segment, if any (there is at most one). */
export async function getOpenSegment(
	db: Db,
	missionId: string,
): Promise<MachineSegment | null> {
	return collection(db).findOne({ missionId, endedAt: { $exists: false } });
}

/** Segments that overlap [since, now], oldest first. */
export async function listSegments(
	db: Db,
	missionId: string,
	since: Date,
): Promise<MachineSegment[]> {
	return collection(db)
		.find({
			missionId,
			$or: [{ endedAt: { $exists: false } }, { endedAt: { $gt: since } }],
		})
		.sort({ startedAt: 1 })
		.toArray();
}

export async function upgradedMsSince(
	db: Db,
	missionId: string,
	since: Date,
	now: Date,
	mode: "elapsed" | "committed",
): Promise<number> {
	return upgradedMs(await listSegments(db, missionId, since), {
		since,
		now,
		mode,
	});
}

// ---------------------------------------------------------------------------
// Reconciliation with live Fly state
// ---------------------------------------------------------------------------

export interface LiveMachine {
	id: string;
	state: string;
	guest?: { cpu_kind?: string; cpus?: number; memory_mb?: number };
}

const RUNNING_STATES = new Set(["started", "starting"]);

/**
 * Make segments match what Fly reports: close segments whose machine is
 * stopped or gone (Fly stopped it after crashes, or a transition was missed),
 * and open one for a running machine that has none (e.g. the scheduler woke a
 * suspended mission), with the machine's real shape.
 */
export async function reconcileSegments(
	db: Db,
	machines: readonly LiveMachine[],
	now: Date = new Date(),
): Promise<{ closed: number; opened: number }> {
	const col = collection(db);
	const live = new Map(machines.map((m) => [m.id, m]));
	let closed = 0;
	let opened = 0;

	const open = await col.find({ endedAt: { $exists: false } }).toArray();
	const openMissionIds = new Set(open.map((s) => s.missionId));
	for (const seg of open) {
		const machine = seg.machineId ? live.get(seg.machineId) : undefined;
		if (machine && RUNNING_STATES.has(machine.state)) continue;
		closed += await closeOpenSegments(db, seg.missionId, now);
		openMissionIds.delete(seg.missionId);
	}

	const running = machines.filter((m) => RUNNING_STATES.has(m.state));
	if (running.length === 0) return { closed, opened };
	const missions = await db
		.collection<{
			missionId: string;
			machineId: string;
			mission?: { memoryMb?: number; cpus?: number };
		}>("missions")
		.find({ machineId: { $in: running.map((m) => m.id) } })
		.toArray();
	for (const mission of missions) {
		if (openMissionIds.has(mission.missionId)) continue;
		const machine = live.get(mission.machineId);
		const fallback = defaultShapeOf(mission);
		const shape: MachineShape = {
			cpuKind:
				machine?.guest?.cpu_kind === "performance" ? "performance" : "shared",
			cpus: machine?.guest?.cpus ?? fallback.cpus,
			memoryMb: machine?.guest?.memory_mb ?? fallback.memoryMb,
		};
		await openSegment(db, {
			missionId: mission.missionId,
			machineId: mission.machineId,
			shape,
			upgraded: !sameShape(shape, fallback),
			startedAt: now,
		});
		opened++;
	}
	return { closed, opened };
}
