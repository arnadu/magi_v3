/**
 * Decision rules for `scripts/reconcile-mission-state.mjs`, kept free of
 * MongoDB and Fly I/O so they can be unit-tested
 * (`packages/control-plane/tests/reconcile-policy.unit.test.ts`).
 *
 * The purge rules exist because "not referenced by any mission document" is
 * not the same as "safe to destroy": a mission whose `volumeId` drifted
 * (issue #62) makes its real, attached data volume look orphaned, and a
 * provision that is still in flight has a machine on Fly before its document
 * is written. Both are skipped here and reported with the reason.
 */

export const DEFAULT_MIN_AGE_HOURS = 24;

/** `created_at` is RFC 3339 on both machines and volumes; a missing or unparsable value counts as age 0 (never old enough). */
function ageMs(resource, now) {
	const t = Date.parse(resource.created_at ?? "");
	return Number.isFinite(t) ? Math.max(0, now - t) : 0;
}

function hours(ms) {
	return (ms / 3_600_000).toFixed(1);
}

/**
 * Split unreferenced Fly resources into those the purge may destroy and
 * those it must leave alone, each skip carrying a human-readable reason.
 *
 * @param {object} input
 * @param {Array<{id:string,name?:string,state?:string,created_at?:string,config?:{mounts?:unknown[]}}>} input.machines
 * @param {Array<{id:string,name?:string,created_at?:string,attached_machine_id?:string|null}>} input.volumes
 * @param {Set<string>} input.referencedMachineIds
 * @param {Set<string>} input.referencedVolumeIds
 * @param {number} input.now epoch ms
 * @param {number} input.minAgeMs resources younger than this are never purged
 */
export function classifyOrphans({
	machines,
	volumes,
	referencedMachineIds,
	referencedVolumeIds,
	now,
	minAgeMs,
}) {
	const result = {
		machines: { purge: [], skipped: [] },
		volumes: { purge: [], skipped: [] },
	};

	for (const m of machines) {
		if (referencedMachineIds.has(m.id)) continue;
		const mounts = m.config?.mounts;
		if (Array.isArray(mounts) && mounts.length > 0) {
			result.machines.skipped.push({
				resource: m,
				reason:
					"has a volume mount — a mission machine whose document is missing or drifted; fix the mission document first",
			});
			continue;
		}
		const age = ageMs(m, now);
		if (age < minAgeMs) {
			result.machines.skipped.push({
				resource: m,
				reason: `created ${hours(age)} h ago, under the ${hours(minAgeMs)} h age gate (a provision may still be in flight)`,
			});
			continue;
		}
		result.machines.purge.push(m);
	}

	for (const v of volumes) {
		if (referencedVolumeIds.has(v.id)) continue;
		if (v.attached_machine_id) {
			result.volumes.skipped.push({
				resource: v,
				reason: `attached to machine ${v.attached_machine_id} — detach or resolve that machine first`,
			});
			continue;
		}
		const age = ageMs(v, now);
		if (age < minAgeMs) {
			result.volumes.skipped.push({
				resource: v,
				reason: `created ${hours(age)} h ago, under the ${hours(minAgeMs)} h age gate`,
			});
			continue;
		}
		result.volumes.purge.push(v);
	}

	return result;
}

/**
 * Correct a mission's `status` only if it still holds the value the scan
 * saw: a resume or suspend that landed between the scan and the fix must
 * win over the scan's stale conclusion.
 *
 * @returns {Promise<"fixed"|"changed-since-scan">}
 */
export async function applyStatusFix(missions, { missionId, from, to }) {
	const r = await missions.updateOne(
		{ missionId, status: from },
		{ $set: { status: to, updatedAt: new Date() } },
	);
	return r.matchedCount === 1 ? "fixed" : "changed-since-scan";
}

/** Parse `--min-age-hours N`; rejects non-numbers and negatives rather than silently defaulting. */
export function parseMinAgeHours(argv) {
	const i = argv.indexOf("--min-age-hours");
	if (i === -1) return DEFAULT_MIN_AGE_HOURS;
	const raw = argv[i + 1];
	const n = Number(raw);
	if (raw === undefined || !Number.isFinite(n) || n < 0) {
		throw new Error(
			`--min-age-hours expects a non-negative number, got ${JSON.stringify(raw)}`,
		);
	}
	return n;
}
