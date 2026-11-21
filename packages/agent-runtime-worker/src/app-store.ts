/**
 * Apps' records in `missionApps` (ADR-0037 decision 6): the daemon's writes.
 * The control plane writes only `slot` and `slotUsedAt`; every update here
 * sets named fields and never replaces a document, so neither writer
 * clobbers the other. Status changes are compare-and-set on the previous
 * status, so a stale view of an app never overwrites a newer one.
 */

import {
	type AppKind,
	type MissionAppDoc,
	storedCollection,
} from "@magi/agent-config";
import type { Collection, Db } from "mongodb";

export interface AppDeclaration {
	name: string;
	owner: string;
	kind: AppKind;
	path: string;
	handlers?: string;
	description: string;
}

export interface AppStore {
	get(name: string): Promise<MissionAppDoc | null>;
	list(): Promise<MissionAppDoc[]>;
	/** Create the record (status `stopped`, a new capability), or update the declaration of an existing one, keeping its capability and slot. */
	declare(d: AppDeclaration, capability: string): Promise<MissionAppDoc>;
	/**
	 * The catalog's transitions of `app`, one function each, each a
	 * compare-and-set on the previous status (false when the record was not
	 * in it), so the trace can check every write against the catalog.
	 */
	/** stopped | failed → starting: started by its owner, the copilot or the operator. */
	toStarting(name: string, restarts: Date[]): Promise<boolean>;
	/** running → starting: crashed within the restart limit (starting stays starting). */
	toRestarting(
		name: string,
		restarts: Date[],
		lastError: string,
	): Promise<boolean>;
	/** starting → running: answered on its port. */
	toRunning(name: string, port: number): Promise<boolean>;
	/** starting | running → failed. */
	toFailed(name: string, lastError: string): Promise<boolean>;
	/** starting | running → stopped. */
	toStopped(name: string): Promise<boolean>;
	update(
		name: string,
		fields: Partial<Pick<MissionAppDoc, "rssMb" | "lastOpenedAt">>,
	): Promise<void>;
	remove(name: string): Promise<void>;
	/** At boot: nothing runs any more, whatever the records say. */
	markAllStopped(): Promise<number>;
}

export function createMongoAppStore(db: Db, missionId: string): AppStore {
	const col = storedCollection(db, "missionApps");
	const key = (name: string) => ({ missionId, name });
	return {
		get: (name) => col.findOne(key(name)),
		list: () => col.find({ missionId }).sort({ name: 1 }).toArray(),
		async declare(d, capability) {
			const now = new Date();
			const declared: Partial<MissionAppDoc> = {
				owner: d.owner,
				kind: d.kind,
				path: d.path,
				description: d.description,
				updatedAt: now,
			};
			const doc = await col.findOneAndUpdate(
				key(d.name),
				{
					$set:
						d.handlers === undefined
							? declared
							: { ...declared, handlers: d.handlers },
					...(d.handlers === undefined ? { $unset: { handlers: "" } } : {}),
					$setOnInsert: {
						missionId,
						name: d.name,
						capability,
						status: "stopped",
						restarts: [],
						declaredAt: now,
						statusChangedAt: now,
					},
				},
				{ upsert: true, returnDocument: "after" },
			);
			if (!doc) throw new Error(`declaring app ${d.name} returned no record`);
			return doc;
		},
		...appTransitions(col, key),
		async update(name, fields) {
			await col.updateOne(key(name), {
				$set: { ...fields, updatedAt: new Date() },
			});
		},
		async remove(name) {
			await col.deleteOne(key(name));
		},
		async markAllStopped() {
			const now = new Date();
			const r = await col.updateMany(
				{ missionId, status: { $in: ["starting", "running"] } },
				{
					$set: { status: "stopped", statusChangedAt: now, updatedAt: now },
					$unset: { port: "" },
				},
			);
			return r.modifiedCount;
		},
	};
}

/** The catalog's transitions of `app`, each a compare-and-set with literal states (see AppStore). */
function appTransitions(
	col: Collection<MissionAppDoc>,
	key: (name: string) => { missionId: string; name: string },
): Pick<
	AppStore,
	"toStarting" | "toRestarting" | "toRunning" | "toFailed" | "toStopped"
> {
	return {
		async toStarting(name, restarts) {
			const now = new Date();
			const r = await col.updateOne(
				{ ...key(name), status: { $in: ["stopped", "failed"] } },
				{
					$set: {
						status: "starting",
						restarts,
						statusChangedAt: now,
						updatedAt: now,
					},
				},
			);
			return r.matchedCount === 1;
		},
		async toRestarting(name, restarts, lastError) {
			const now = new Date();
			const r = await col.updateOne(
				{ ...key(name), status: "running" },
				{
					$set: {
						status: "starting",
						restarts,
						lastError,
						statusChangedAt: now,
						updatedAt: now,
					},
					$unset: { port: "" },
				},
			);
			if (r.matchedCount === 1) return true;
			// Already starting (it crashed before it answered): the status stays.
			const s = await col.updateOne(
				{ ...key(name), status: "starting" },
				{ $set: { restarts, lastError, updatedAt: now } },
			);
			return s.matchedCount === 1;
		},
		async toRunning(name, port) {
			const now = new Date();
			const r = await col.updateOne(
				{ ...key(name), status: "starting" },
				{
					$set: {
						status: "running",
						port,
						statusChangedAt: now,
						updatedAt: now,
					},
				},
			);
			return r.matchedCount === 1;
		},
		async toFailed(name, lastError) {
			const now = new Date();
			const r = await col.updateOne(
				{ ...key(name), status: { $in: ["starting", "running"] } },
				{
					$set: {
						status: "failed",
						lastError,
						statusChangedAt: now,
						updatedAt: now,
					},
					$unset: { port: "" },
				},
			);
			return r.matchedCount === 1;
		},
		async toStopped(name) {
			const now = new Date();
			const r = await col.updateOne(
				{ ...key(name), status: { $in: ["starting", "running"] } },
				{
					$set: { status: "stopped", statusChangedAt: now, updatedAt: now },
					$unset: { port: "" },
				},
			);
			return r.matchedCount === 1;
		},
	};
}

export async function ensureAppIndexes(db: Db): Promise<void> {
	await storedCollection(db, "missionApps").createIndex(
		{ missionId: 1, name: 1 },
		{ unique: true },
	);
}
