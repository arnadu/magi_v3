/**
 * Minimal in-memory Mongo fake for control-plane unit tests. Supports only
 * what the resource modules use: dotted paths; equality (Dates and ObjectIds
 * by value); $exists, $in, $ne, $gt, $gte, $lt, $lte, $or; $set / $unset;
 * find/sort, findOne, findOneAndUpdate, updateOne (with upsert)/Many, insertOne,
 * deleteOne.
 * Not a general Mongo emulator.
 */

import type { Db } from "mongodb";
import { ObjectId } from "mongodb";

export type Doc = Record<string, unknown>;

function getPath(doc: Doc, path: string): unknown {
	let cur: unknown = doc;
	for (const key of path.split(".")) {
		if (typeof cur !== "object" || cur === null) return undefined;
		cur = (cur as Doc)[key];
	}
	return cur;
}

function setPath(doc: Doc, path: string, value: unknown): void {
	const keys = path.split(".");
	let cur = doc;
	for (const key of keys.slice(0, -1)) {
		if (typeof cur[key] !== "object" || cur[key] === null) cur[key] = {};
		cur = cur[key] as Doc;
	}
	cur[keys[keys.length - 1]] = value;
}

function unsetPath(doc: Doc, path: string): void {
	const keys = path.split(".");
	let cur: unknown = doc;
	for (const key of keys.slice(0, -1)) {
		if (typeof cur !== "object" || cur === null) return;
		cur = (cur as Doc)[key];
	}
	if (typeof cur === "object" && cur !== null) {
		delete (cur as Doc)[keys[keys.length - 1]];
	}
}

const isOperatorObject = (v: unknown): v is Doc =>
	typeof v === "object" &&
	v !== null &&
	!(v instanceof Date) &&
	!(v instanceof ObjectId) &&
	Object.keys(v).some((k) => k.startsWith("$"));

function comparable(v: unknown): unknown {
	if (v instanceof Date) return v.getTime();
	if (v instanceof ObjectId) return v.toHexString();
	return v;
}

function matchesValue(actual: unknown, cond: unknown): boolean {
	if (!isOperatorObject(cond)) return comparable(actual) === comparable(cond);
	for (const [op, arg] of Object.entries(cond)) {
		const a = comparable(actual);
		const b = comparable(arg);
		switch (op) {
			case "$exists":
				if ((actual !== undefined) !== arg) return false;
				break;
			case "$in":
				if (!(arg as unknown[]).map(comparable).includes(a)) return false;
				break;
			case "$ne":
				if (a === b) return false;
				break;
			case "$gt":
				if (!(actual !== undefined && (a as number) > (b as number)))
					return false;
				break;
			case "$gte":
				if (!(actual !== undefined && (a as number) >= (b as number)))
					return false;
				break;
			case "$lt":
				if (!(actual !== undefined && (a as number) < (b as number)))
					return false;
				break;
			case "$lte":
				if (!(actual !== undefined && (a as number) <= (b as number)))
					return false;
				break;
			default:
				throw new Error(`fake-db: unsupported operator ${op}`);
		}
	}
	return true;
}

function matches(doc: Doc, filter: Doc): boolean {
	for (const [key, cond] of Object.entries(filter)) {
		if (key === "$or") {
			if (!(cond as Doc[]).some((f) => matches(doc, f))) return false;
		} else if (!matchesValue(getPath(doc, key), cond)) {
			return false;
		}
	}
	return true;
}

function applyUpdate(doc: Doc, update: Doc): void {
	for (const [path, value] of Object.entries((update.$set ?? {}) as Doc)) {
		setPath(doc, path, value);
	}
	for (const path of Object.keys((update.$unset ?? {}) as Doc)) {
		unsetPath(doc, path);
	}
}

const copy = (d: Doc): Doc => structuredClone(d);

function collectionOver(docs: Doc[]) {
	return {
		async createIndex() {
			return "ok";
		},
		async insertOne(doc: Doc) {
			const stored = { ...doc };
			if (stored._id === undefined) stored._id = new ObjectId();
			docs.push(stored);
			return { acknowledged: true, insertedId: stored._id };
		},
		async findOne(filter: Doc) {
			const d = docs.find((x) => matches(x, filter));
			return d ? copy(d) : null;
		},
		async findOneAndUpdate(
			filter: Doc,
			update: Doc,
			opts: { returnDocument?: "before" | "after" } = {},
		) {
			const d = docs.find((x) => matches(x, filter));
			if (!d) return null;
			const before = copy(d);
			applyUpdate(d, update);
			return opts.returnDocument === "before" ? before : copy(d);
		},
		async updateOne(filter: Doc, update: Doc, opts: { upsert?: boolean } = {}) {
			const d = docs.find((x) => matches(x, filter));
			if (d) {
				applyUpdate(d, update);
				return { modifiedCount: 1 };
			}
			if (opts.upsert) {
				const fresh: Doc = {};
				for (const [k, v] of Object.entries(filter)) {
					if (!k.startsWith("$") && !isOperatorObject(v)) setPath(fresh, k, v);
				}
				applyUpdate(fresh, update);
				docs.push(fresh);
				return { modifiedCount: 0, upsertedCount: 1 };
			}
			return { modifiedCount: 0 };
		},
		async updateMany(filter: Doc, update: Doc) {
			let modifiedCount = 0;
			for (const d of docs) {
				if (matches(d, filter)) {
					applyUpdate(d, update);
					modifiedCount++;
				}
			}
			return { modifiedCount };
		},
		async deleteOne(filter: Doc) {
			const i = docs.findIndex((x) => matches(x, filter));
			if (i >= 0) docs.splice(i, 1);
			return { deletedCount: i >= 0 ? 1 : 0 };
		},
		find(filter: Doc) {
			let result = docs.filter((d) => matches(d, filter));
			const cursor = {
				sort(spec: Record<string, 1 | -1>) {
					const [[key, dir]] = Object.entries(spec);
					result = [...result].sort(
						(a, b) =>
							((comparable(getPath(a, key)) as number) -
								(comparable(getPath(b, key)) as number)) *
							dir,
					);
					return cursor;
				},
				async toArray() {
					return result.map(copy);
				},
			};
			return cursor;
		},
	};
}

/** `initial` seeds named collections; the returned `data` arrays are live and mutated by the fake. */
export function fakeDb(initial: Record<string, Doc[]> = {}) {
	const data: Record<string, Doc[]> = {};
	for (const [name, docs] of Object.entries(initial)) data[name] = docs;
	const db = {
		collection(name: string) {
			data[name] ??= [];
			return collectionOver(data[name]);
		},
	} as unknown as Db;
	return { db, data };
}
