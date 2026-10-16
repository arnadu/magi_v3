/**
 * Orphan-machine detection for the 5-min resource-monitor tick (ADR-0032):
 * machines in the missions app that no live mission document references.
 *
 * Why it exists: Fly bills and quota-limits by machine, and the org-wide
 * machine limit is enforced on *every* create and update — a leaked machine
 * nobody can see blocks control-plane deploys and new missions alike
 * (2026-10-16: deploys failed for a day with "organization has reached its
 * machine limit"; one genuine orphan plus one parked machine per suspended
 * mission). `scripts/reconcile-mission-state.mjs` finds the same thing but
 * only when someone runs it. This check posts to the platform admins' copilot
 * inboxes the first time an orphan is seen and whenever a new one appears, and
 * records the machine count in `platformResources` so the daily report can
 * show quota pressure.
 *
 * "Referenced" means the `machineId` of any mission whose status is not
 * "destroyed". Machines younger than ORPHAN_GRACE_MS are ignored: a provision
 * or resize writes the new `machineId` to the doc only after Fly returns the
 * handle, so a brand-new machine is briefly unreferenced by design.
 */

import type { Db } from "mongodb";
import { type FlyMachineSummary, listMachines } from "./fly-machines.js";
import { relayToPlatformAdmins } from "./platform-relay.js";

export const ORPHAN_GRACE_MS = 10 * 60_000;

/** `platformResources` document id for the machine-count sample. */
export const FLY_MACHINES_SAMPLE_ID = "fly-machines";

export interface OrphanMachine {
	id: string;
	name?: string;
	state?: string;
	/** `MISSION_ID` from the machine's env, when `provisionMission` set one — tells which mission leaked it. */
	missionIdEnv?: string;
	createdAt?: string;
}

export interface FlyMachinesSample {
	total: number;
	referenced: number;
	orphans: OrphanMachine[];
}

export interface CheckOrphanMachinesDeps {
	db: Db;
	/** Recipients — `PLATFORM_ADMIN_USER_IDS`, parsed by the caller. */
	platformAdminUserIds: string[];
	/** Injected for tests; defaults to the real Fly Machines API. */
	listMachinesFn?: () => Promise<FlyMachineSummary[]>;
	now?: () => Date;
}

/** Pure: which of `machines` are unreferenced and past the grace period. */
export function findOrphanMachines(
	machines: FlyMachineSummary[],
	referencedIds: ReadonlySet<string>,
	now: Date,
): OrphanMachine[] {
	const orphans: OrphanMachine[] = [];
	for (const m of machines) {
		if (referencedIds.has(m.id)) continue;
		const createdMs = m.created_at ? Date.parse(m.created_at) : Number.NaN;
		if (!Number.isNaN(createdMs) && now.getTime() - createdMs < ORPHAN_GRACE_MS)
			continue;
		orphans.push({
			id: m.id,
			name: m.name,
			state: m.state,
			missionIdEnv: m.config?.env?.MISSION_ID,
			createdAt: m.created_at,
		});
	}
	return orphans;
}

function describeOrphans(sample: FlyMachinesSample, app: string): string {
	const lines = sample.orphans.map((o) => {
		const parts = [o.id];
		if (o.name) parts.push(o.name);
		if (o.state) parts.push(o.state);
		if (o.missionIdEnv) parts.push(`MISSION_ID=${o.missionIdEnv}`);
		if (o.createdAt) parts.push(`created ${o.createdAt}`);
		return `- ${parts.join(" · ")}`;
	});
	return (
		`${sample.orphans.length} Fly machine(s) in ${app} are not referenced by any live mission ` +
		`(${sample.total} machine(s) total, ${sample.referenced} referenced). Each one counts against ` +
		`the organization's machine limit, which blocks deploys and new missions when reached.\n` +
		`${lines.join("\n")}\n` +
		`Confirm with \`node scripts/reconcile-mission-state.mjs\` (report-only), then ` +
		`\`--purge-orphans\` to destroy them. A machine whose MISSION_ID names a live mission ` +
		`with a different machineId is a leaked predecessor, not that mission's current machine.`
	);
}

/**
 * List machines, diff against live mission docs, persist the sample, and
 * relay newly-seen orphans to every platform admin. Returns the sample, or
 * null when Fly could not be listed. Never throws.
 */
export async function checkOrphanMachines(
	deps: CheckOrphanMachinesDeps,
): Promise<FlyMachinesSample | null> {
	const now = (deps.now ?? (() => new Date()))();
	const listMachinesFn = deps.listMachinesFn ?? listMachines;

	let machines: FlyMachineSummary[];
	try {
		machines = await listMachinesFn();
	} catch (e) {
		console.error(
			`[fly-orphans] Failed to list machines: ${(e as Error).message}`,
		);
		return null;
	}

	const liveMissions = await deps.db
		.collection<{ missionId: string; status: string; machineId?: string }>(
			"missions",
		)
		.find({ status: { $ne: "destroyed" } })
		.toArray();
	const referencedIds = new Set(
		liveMissions.map((m) => m.machineId).filter((id): id is string => !!id),
	);
	const orphans = findOrphanMachines(machines, referencedIds, now);
	const sample: FlyMachinesSample = {
		total: machines.length,
		referenced: machines.filter((m) => referencedIds.has(m.id)).length,
		orphans,
	};

	const platform = deps.db.collection<{
		_id: string;
		alertedOrphanIds?: string[];
	}>("platformResources");
	let alertedOrphanIds: string[] = [];
	try {
		const prev = await platform.findOne({ _id: FLY_MACHINES_SAMPLE_ID });
		alertedOrphanIds = prev?.alertedOrphanIds ?? [];
	} catch (e) {
		console.error(
			`[fly-orphans] Failed to read the previous sample: ${(e as Error).message} — treating every orphan as new`,
		);
	}

	const orphanIds = orphans.map((o) => o.id);
	const hasNew = orphanIds.some((id) => !alertedOrphanIds.includes(id));
	if (hasNew && deps.platformAdminUserIds.length === 0) {
		console.warn(
			`[fly-orphans] ${orphanIds.length} orphan machine(s) found but PLATFORM_ADMIN_USER_IDS is empty — nobody is alerted { ids: ${JSON.stringify(orphanIds)} }`,
		);
	}
	if (hasNew && deps.platformAdminUserIds.length > 0) {
		const app = process.env.FLY_MISSIONS_APP_NAME ?? "the missions app";
		await relayToPlatformAdmins(deps.db, deps.platformAdminUserIds, {
			category: "orphan-machines",
			body: describeOrphans(sample, app),
			now,
		});
	}

	try {
		await platform.updateOne(
			{ _id: FLY_MACHINES_SAMPLE_ID },
			{
				$set: {
					total: sample.total,
					referenced: sample.referenced,
					orphans,
					// Only ids that were actually relayed (or had been before) count
					// as alerted; with no admins configured every tick keeps warning.
					alertedOrphanIds:
						deps.platformAdminUserIds.length > 0 ? orphanIds : alertedOrphanIds,
					updatedAt: now,
				},
			},
			{ upsert: true },
		);
	} catch (e) {
		console.error(
			`[fly-orphans] Failed to store the sample: ${(e as Error).message}`,
		);
	}
	return sample;
}
