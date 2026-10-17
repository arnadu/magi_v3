import { describe, expect, it } from "vitest";
import {
	applyStatusFix,
	classifyOrphans,
	DEFAULT_MIN_AGE_HOURS,
	parseMinAgeHours,
} from "../../../scripts/lib/reconcile-policy.mjs";

const H = 3_600_000;
const now = Date.parse("2026-10-17T12:00:00Z");
const at = (hoursAgo: number) => new Date(now - hoursAgo * H).toISOString();

describe("classifyOrphans — RECON1 guards", () => {
	it("never purges a referenced resource", () => {
		const r = classifyOrphans({
			machines: [{ id: "m1", created_at: at(100) }],
			volumes: [{ id: "v1", created_at: at(100) }],
			referencedMachineIds: new Set(["m1"]),
			referencedVolumeIds: new Set(["v1"]),
			now,
			minAgeMs: 24 * H,
		});
		expect(r.machines.purge).toEqual([]);
		expect(r.volumes.purge).toEqual([]);
		expect(r.machines.skipped).toEqual([]);
	});

	it("skips a machine that mounts a volume (a drifted mission's real machine)", () => {
		const r = classifyOrphans({
			machines: [
				{
					id: "m-drift",
					created_at: at(100),
					config: { mounts: [{ volume: "vol_x", path: "/missions" }] },
				},
			],
			volumes: [],
			referencedMachineIds: new Set(),
			referencedVolumeIds: new Set(),
			now,
			minAgeMs: 24 * H,
		});
		expect(r.machines.purge).toEqual([]);
		expect(r.machines.skipped[0].reason).toMatch(/volume mount/);
	});

	it("skips an attached volume even when no document references it (#62 shape)", () => {
		const r = classifyOrphans({
			machines: [],
			volumes: [
				{ id: "v-real", created_at: at(100), attached_machine_id: "m-live" },
			],
			referencedMachineIds: new Set(),
			referencedVolumeIds: new Set(["vol_wrong"]),
			now,
			minAgeMs: 24 * H,
		});
		expect(r.volumes.purge).toEqual([]);
		expect(r.volumes.skipped[0].reason).toContain("m-live");
	});

	it("skips resources younger than the age gate and treats a missing created_at as age 0", () => {
		const r = classifyOrphans({
			machines: [
				{ id: "m-new", created_at: at(1) },
				{ id: "m-nodate" },
				{ id: "m-old", created_at: at(48) },
			],
			volumes: [
				{ id: "v-new", created_at: at(2), attached_machine_id: null },
				{ id: "v-old", created_at: at(72), attached_machine_id: null },
			],
			referencedMachineIds: new Set(),
			referencedVolumeIds: new Set(),
			now,
			minAgeMs: 24 * H,
		});
		expect(r.machines.purge.map((m) => m.id)).toEqual(["m-old"]);
		expect(r.machines.skipped.map((s) => s.resource.id)).toEqual([
			"m-new",
			"m-nodate",
		]);
		expect(r.volumes.purge.map((v) => v.id)).toEqual(["v-old"]);
		expect(r.volumes.skipped.map((s) => s.resource.id)).toEqual(["v-new"]);
	});
});

describe("applyStatusFix — RECON2 compare-and-set", () => {
	function fakeMissions(matched: number) {
		const calls: Array<{ filter: unknown; update: unknown }> = [];
		return {
			calls,
			updateOne: async (filter: unknown, update: unknown) => {
				calls.push({ filter, update });
				return { matchedCount: matched };
			},
		};
	}

	it("filters on the status the scan saw, not just the mission id", async () => {
		const missions = fakeMissions(1);
		const outcome = await applyStatusFix(missions, {
			missionId: "m1",
			from: "running",
			to: "suspended",
		});
		expect(outcome).toBe("fixed");
		expect(missions.calls[0].filter).toEqual({
			missionId: "m1",
			status: "running",
		});
	});

	it("reports a status that moved between scan and fix instead of overwriting it", async () => {
		const missions = fakeMissions(0);
		await expect(
			applyStatusFix(missions, {
				missionId: "m1",
				from: "running",
				to: "suspended",
			}),
		).resolves.toBe("changed-since-scan");
	});
});

describe("parseMinAgeHours", () => {
	it("defaults to 24 h and accepts an explicit value", () => {
		expect(parseMinAgeHours([])).toBe(DEFAULT_MIN_AGE_HOURS);
		expect(parseMinAgeHours(["--yes", "--min-age-hours", "6"])).toBe(6);
	});

	it("rejects a missing, non-numeric or negative value", () => {
		expect(() => parseMinAgeHours(["--min-age-hours"])).toThrow(/expects/);
		expect(() => parseMinAgeHours(["--min-age-hours", "soon"])).toThrow();
		expect(() => parseMinAgeHours(["--min-age-hours", "-1"])).toThrow();
	});
});
