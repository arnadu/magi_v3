/**
 * Minimal in-memory Mongo fake for the machine-segment and lifecycle unit
 * tests: just the operators those modules use (equality, $exists, $in, $gt,
 * $or). Not a general Mongo emulator.
 */

import type { Db } from "mongodb";

export type Doc = Record<string, unknown>;

function matchesValue(actual: unknown, cond: unknown): boolean {
	if (typeof cond === "object" && cond !== null && !(cond instanceof Date)) {
		const c = cond as Record<string, unknown>;
		if ("$exists" in c) {
			const exists = actual !== undefined;
			if (exists !== c.$exists) return false;
		}
		if ("$in" in c && !(c.$in as unknown[]).includes(actual)) return false;
		if ("$gt" in c && !((actual as Date) > (c.$gt as Date))) return false;
		return true;
	}
	return actual === cond;
}

function matches(doc: Doc, filter: Doc): boolean {
	for (const [key, cond] of Object.entries(filter)) {
		if (key === "$or") {
			if (!(cond as Doc[]).some((f) => matches(doc, f))) return false;
		} else if (!matchesValue(doc[key], cond)) {
			return false;
		}
	}
	return true;
}

function collectionOver(docs: Doc[]) {
	return {
		async createIndex() {
			return "ok";
		},
		async insertOne(doc: Doc) {
			docs.push({ ...doc });
		},
		async updateMany(filter: Doc, update: { $set: Doc }) {
			let modifiedCount = 0;
			for (const d of docs) {
				if (matches(d, filter)) {
					Object.assign(d, update.$set);
					modifiedCount++;
				}
			}
			return { modifiedCount };
		},
		async updateOne(filter: Doc, update: { $set: Doc }) {
			const d = docs.find((x) => matches(x, filter));
			if (d) Object.assign(d, update.$set);
			return { modifiedCount: d ? 1 : 0 };
		},
		find(filter: Doc) {
			let result = docs.filter((d) => matches(d, filter));
			const cursor = {
				sort(spec: Record<string, 1 | -1>) {
					const [[key, dir]] = Object.entries(spec);
					result = [...result].sort(
						(a, b) =>
							((a[key] as Date).getTime() - (b[key] as Date).getTime()) * dir,
					);
					return cursor;
				},
				async toArray() {
					return result.map((d) => ({ ...d }));
				},
			};
			return cursor;
		},
	};
}

export function fakeSegmentsDb(opts: { missions?: Doc[] } = {}) {
	const segments: Doc[] = [];
	const missions = opts.missions ?? [];
	const db = {
		collection(name: string) {
			if (name === "machineSegments") return collectionOver(segments);
			if (name === "missions") return collectionOver(missions);
			throw new Error(`unexpected collection ${name}`);
		},
	} as unknown as Db;
	return { db, segments, missions };
}
