/**
 * Which port of the apps host each app holds (ADR-0037 decision 2): its
 * origin. Kept on the app's own record (`missionApps.slot`, `slotUsedAt`),
 * unique across missions by a partial unique index, so two apps never hold
 * one port. The control plane writes only these two fields.
 *
 * An app keeps its slot. A slot passes to another app only when its holder
 * was removed (deleting the record frees it) or has not been opened for
 * longer than a session lasts, so no live session of the old holder can
 * share the origin with the new one.
 */

import {
	APP_SESSION_TTL_MS,
	type MissionAppDoc,
	storedCollection,
} from "@magi/agent-config";
import type { Collection, Db } from "mongodb";
import { FIRST_SLOT, LAST_SLOT } from "./policy.js";

const DUPLICATE_KEY = 11000;

export async function ensureSlotIndex(db: Db): Promise<void> {
	await storedCollection(db, "missionApps").createIndex(
		{ slot: 1 },
		{ unique: true, partialFilterExpression: { slot: { $exists: true } } },
	);
}

export class NoFreeSlotError extends Error {
	constructor() {
		super(
			`all ${LAST_SLOT - FIRST_SLOT + 1} app ports are held by apps opened in the last 12 hours; stop or remove one, or wait`,
		);
	}
}

const isDuplicate = (e: unknown) =>
	(e as { code?: number }).code === DUPLICATE_KEY;

/** The app's slot, assigning one if it has none; records the use either way. */
export async function assignSlot(
	col: Collection<MissionAppDoc>,
	app: Pick<MissionAppDoc, "missionId" | "name" | "slot">,
	now = new Date(),
): Promise<number> {
	const key = { missionId: app.missionId, name: app.name };
	if (app.slot !== undefined) {
		const r = await col.updateOne(
			{ ...key, slot: app.slot },
			{ $set: { slotUsedAt: now } },
		);
		if (r.matchedCount === 1) return app.slot;
	}
	const held = await col
		.find(
			{ slot: { $exists: true } },
			{ projection: { slot: 1, slotUsedAt: 1 } },
		)
		.toArray();
	const taken = new Set(held.map((h) => h.slot));
	/** A failed claim may mean a concurrent open of this app won: use its slot. */
	const ownSlot = async () => (await col.findOne(key))?.slot;
	for (let s = FIRST_SLOT; s <= LAST_SLOT; s++) {
		if (taken.has(s)) continue;
		if (await claim(col, key, s, now)) return s;
		const mine = await ownSlot();
		if (mine !== undefined) return mine;
	}
	// Every slot is held: take one whose holder's sessions have all expired.
	const cutoff = new Date(now.getTime() - APP_SESSION_TTL_MS);
	const stale = held
		.filter((h) => h.slotUsedAt && h.slotUsedAt < cutoff)
		.sort(
			(a, b) => (a.slotUsedAt?.getTime() ?? 0) - (b.slotUsedAt?.getTime() ?? 0),
		);
	for (const h of stale) {
		const freed = await col.updateOne(
			{ _id: h._id, slot: h.slot, slotUsedAt: h.slotUsedAt },
			{ $unset: { slot: "", slotUsedAt: "" } },
		);
		if (
			freed.matchedCount === 1 &&
			(await claim(col, key, h.slot as number, now))
		)
			return h.slot as number;
	}
	throw new NoFreeSlotError();
}

/** Give `slot` to the app if it has none; false when another app took it first. */
async function claim(
	col: Collection<MissionAppDoc>,
	key: { missionId: string; name: string },
	slot: number,
	now: Date,
): Promise<boolean> {
	try {
		const r = await col.updateOne(
			{ ...key, slot: { $exists: false } },
			{ $set: { slot, slotUsedAt: now } },
		);
		return r.matchedCount === 1;
	} catch (e) {
		if (isDuplicate(e)) return false;
		throw e;
	}
}
