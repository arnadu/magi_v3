/**
 * De-duplication and hysteresis for resource alerts (ADR-0032 Decision 3).
 *
 * A resource that sits above a threshold would otherwise re-alert on every
 * sample. State is kept per alert key (`<missionId|platform>:<category>`) in
 * `resourceAlertState`, and `evaluateAlert` decides whether *this* reading
 * should produce an alert:
 *
 *   - first time above a threshold, or the level rises → alert;
 *   - same level again → alert only after ALERT_REPEAT_HOURS;
 *   - falling back → nothing, and the state is only forgotten once the ratio
 *     is ALERT_CLEAR_HYSTERESIS below the threshold, so a reading that
 *     hovers around a line does not flap.
 */

import type { Db } from "mongodb";
import {
	ALERT_CLEAR_HYSTERESIS,
	ALERT_REPEAT_HOURS,
	type LevelThresholds,
} from "./resource-thresholds.js";

export type AlertLevel = "soft" | "hard";

const RANK: Record<AlertLevel, number> = { soft: 1, hard: 2 };

export interface AlertState {
	key: string;
	level: AlertLevel;
	lastAlertAt: Date;
}

export interface AlertStateStore {
	get(key: string): Promise<AlertState | null>;
	put(state: AlertState): Promise<void>;
	clear(key: string): Promise<void>;
}

/** The level a ratio reaches, ignoring history; null when below the soft threshold. */
export function levelFor(
	ratio: number,
	thresholds: LevelThresholds,
): AlertLevel | null {
	if (ratio >= thresholds.hard) return "hard";
	if (ratio >= thresholds.soft) return "soft";
	return null;
}

/**
 * Decide whether the reading `ratio` should alert now, recording the outcome.
 * Returns the level to emit, or null for "stay quiet".
 *
 * Fails open: if the state store is unreachable the reading's own level is
 * returned, so an outage in de-duplication can cause a repeated alert but
 * never a missed one.
 */
export async function evaluateAlert(
	store: AlertStateStore,
	key: string,
	ratio: number,
	thresholds: LevelThresholds,
	now: Date = new Date(),
): Promise<AlertLevel | null> {
	try {
		return await decide(store, key, ratio, thresholds, now);
	} catch (e) {
		console.error(
			`[resource-alert-state] State store failed, alerting without de-duplication { key: "${key}", ratio: ${ratio}, error: "${(e as Error).message}" }`,
		);
		return levelFor(ratio, thresholds);
	}
}

async function decide(
	store: AlertStateStore,
	key: string,
	ratio: number,
	thresholds: LevelThresholds,
	now: Date,
): Promise<AlertLevel | null> {
	const level = levelFor(ratio, thresholds);
	const state = await store.get(key);

	if (level === null) {
		if (state && ratio < thresholds.soft - ALERT_CLEAR_HYSTERESIS) {
			await store.clear(key);
		}
		return null;
	}

	if (!state || RANK[level] > RANK[state.level]) {
		await store.put({ key, level, lastAlertAt: now });
		return level;
	}

	let current = state;
	if (
		RANK[level] < RANK[state.level] &&
		ratio < thresholds.hard - ALERT_CLEAR_HYSTERESIS
	) {
		// Clearly out of the hard band: remember only the lower level, so the
		// next rise into the hard band alerts again, without alerting now.
		current = { ...state, level };
		await store.put(current);
	}

	const repeatAfterMs = ALERT_REPEAT_HOURS * 3_600_000;
	if (now.getTime() - current.lastAlertAt.getTime() >= repeatAfterMs) {
		await store.put({ key, level, lastAlertAt: now });
		return level;
	}
	return null;
}

export function createMongoAlertStateStore(db: Db): AlertStateStore {
	const col = db.collection<{
		_id: string;
		level: AlertLevel;
		lastAlertAt: Date;
	}>("resourceAlertState");

	return {
		async get(key) {
			const doc = await col.findOne({ _id: key });
			return doc
				? { key, level: doc.level, lastAlertAt: doc.lastAlertAt }
				: null;
		},
		async put({ key, level, lastAlertAt }) {
			await col.updateOne(
				{ _id: key },
				{ $set: { level, lastAlertAt } },
				{ upsert: true },
			);
		},
		async clear(key) {
			await col.deleteOne({ _id: key });
		},
	};
}
