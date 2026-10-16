/**
 * Orphan-machine detection (resource-monitor tick). Fly is injected; Mongo is
 * the shared in-memory fake.
 */

import { describe, expect, it } from "vitest";
import type { FlyMachineSummary } from "../src/fly-machines.js";
import {
	checkOrphanMachines,
	FLY_MACHINES_SAMPLE_ID,
	findOrphanMachines,
	ORPHAN_GRACE_MS,
} from "../src/fly-orphans.js";
import { fakeDb } from "./support/fake-db.js";

const now = new Date("2026-10-16T12:00:00Z");
const old = new Date(now.getTime() - 2 * ORPHAN_GRACE_MS).toISOString();
const young = new Date(now.getTime() - ORPHAN_GRACE_MS / 2).toISOString();

function machine(
	id: string,
	over: Partial<FlyMachineSummary> = {},
): FlyMachineSummary {
	return { id, name: `name-${id}`, state: "stopped", created_at: old, ...over };
}

describe("findOrphanMachines", () => {
	it("flags unreferenced machines past the grace period and keeps the MISSION_ID env", () => {
		const orphans = findOrphanMachines(
			[
				machine("ref"),
				machine("leak", { config: { env: { MISSION_ID: "m1" } } }),
			],
			new Set(["ref"]),
			now,
		);
		expect(orphans).toEqual([
			{
				id: "leak",
				name: "name-leak",
				state: "stopped",
				missionIdEnv: "m1",
				createdAt: old,
			},
		]);
	});

	it("ignores a machine younger than the grace period (provision/resize write the id after Fly returns)", () => {
		expect(
			findOrphanMachines(
				[machine("new", { created_at: young })],
				new Set(),
				now,
			),
		).toEqual([]);
	});

	it("treats a machine with no created_at as old enough to report", () => {
		const orphans = findOrphanMachines(
			[machine("x", { created_at: undefined })],
			new Set(),
			now,
		);
		expect(orphans.map((o) => o.id)).toEqual(["x"]);
	});
});

describe("checkOrphanMachines", () => {
	const admins = ["admin-1", "admin-2"];

	it("counts only live missions' machines as referenced and alerts every admin once per new orphan set", async () => {
		const { db, data } = fakeDb({
			missions: [
				{ missionId: "live", status: "running", machineId: "ref" },
				{ missionId: "gone", status: "destroyed", machineId: "stale" },
			],
		});
		const machines = [machine("ref"), machine("stale"), machine("leak")];
		const sample = await checkOrphanMachines({
			db,
			platformAdminUserIds: admins,
			listMachinesFn: async () => machines,
			now: () => now,
		});

		expect(sample).toMatchObject({ total: 3, referenced: 1 });
		expect(sample?.orphans.map((o) => o.id).sort()).toEqual(["leak", "stale"]);
		const mail = data.mailbox ?? [];
		expect(mail).toHaveLength(2);
		expect(mail.map((m) => m.missionId).sort()).toEqual([
			"copilot-admin-1",
			"copilot-admin-2",
		]);
		expect(mail[0].subject).toBe("Anomaly (hard): orphan-machines");
		expect(String(mail[0].body)).toContain("leak");
		expect(String(mail[0].body)).toContain("--purge-orphans");
		const doc = (data.platformResources ?? []).find(
			(d) => d._id === FLY_MACHINES_SAMPLE_ID,
		);
		expect(doc).toMatchObject({ total: 3, referenced: 1 });
		expect((doc?.alertedOrphanIds as string[]).sort()).toEqual([
			"leak",
			"stale",
		]);

		// Same orphans on the next tick: no new mail. A new one: mail again.
		await checkOrphanMachines({
			db,
			platformAdminUserIds: admins,
			listMachinesFn: async () => machines,
			now: () => now,
		});
		expect(data.mailbox).toHaveLength(2);
		await checkOrphanMachines({
			db,
			platformAdminUserIds: admins,
			listMachinesFn: async () => [...machines, machine("leak-2")],
			now: () => now,
		});
		expect(data.mailbox).toHaveLength(4);
	});

	it("re-alerts when an orphan disappears and later comes back", async () => {
		const { db, data } = fakeDb({ missions: [] });
		const deps = { db, platformAdminUserIds: ["a"], now: () => now };
		await checkOrphanMachines({
			...deps,
			listMachinesFn: async () => [machine("leak")],
		});
		await checkOrphanMachines({ ...deps, listMachinesFn: async () => [] });
		await checkOrphanMachines({
			...deps,
			listMachinesFn: async () => [machine("leak")],
		});
		expect(data.mailbox).toHaveLength(2);
	});

	it("with no admins configured, records the sample but never marks orphans as alerted", async () => {
		const { db, data } = fakeDb({ missions: [] });
		await checkOrphanMachines({
			db,
			platformAdminUserIds: [],
			listMachinesFn: async () => [machine("leak")],
			now: () => now,
		});
		expect(data.mailbox ?? []).toHaveLength(0);
		const doc = (data.platformResources ?? [])[0];
		expect(doc).toMatchObject({ total: 1, orphans: [{ id: "leak" }] });
		expect(doc.alertedOrphanIds).toEqual([]);
	});

	it("returns null and touches nothing when Fly cannot be listed", async () => {
		const { db, data } = fakeDb({ missions: [] });
		const sample = await checkOrphanMachines({
			db,
			platformAdminUserIds: admins,
			listMachinesFn: async () => {
				throw new Error("fly down");
			},
			now: () => now,
		});
		expect(sample).toBeNull();
		expect(data.mailbox ?? []).toHaveLength(0);
		expect(data.platformResources ?? []).toHaveLength(0);
	});
});
