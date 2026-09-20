/** In-memory Mongo fake for the machine-segment and lifecycle unit tests; see fake-db.ts. */

import { type Doc, fakeDb } from "./fake-db.js";

export type { Doc };

export function fakeSegmentsDb(opts: { missions?: Doc[] } = {}) {
	const { db, data } = fakeDb({
		machineSegments: [],
		missions: opts.missions ?? [],
	});
	return { db, segments: data.machineSegments, missions: data.missions };
}
