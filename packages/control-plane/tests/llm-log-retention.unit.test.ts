import type { Db } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { pruneOldLogEntries } from "../src/scheduler.js";

type Filter = { savedAt: { $lt: Date }; input?: unknown };

/** The two llmCallLog writes the pruner makes, recorded; `stripFails` refuses the update as a full cluster would. */
function fakeLog(stripFails = false) {
	const updates: { filter: Filter; update: unknown }[] = [];
	const deletes: Filter[] = [];
	const db = {
		collection: () => ({
			async updateMany(filter: Filter, update: unknown) {
				if (stripFails) throw new Error("you are over your space quota");
				updates.push({ filter, update });
				return { modifiedCount: 3 };
			},
			async deleteMany(filter: Filter) {
				deletes.push(filter);
				return { deletedCount: 1 };
			},
		}),
	} as unknown as Db;
	return { db, updates, deletes };
}

const ageDays = (d: Date) => (Date.now() - d.getTime()) / 86_400_000;

describe("llmCallLog retention (LL1)", () => {
	it("strips call bodies after a day and deletes rows after 90 days", async () => {
		const { db, updates, deletes } = fakeLog();
		await pruneOldLogEntries(db);
		expect(updates).toHaveLength(1);
		expect(updates[0].update).toEqual({ $unset: { input: "", output: "" } });
		expect(ageDays(updates[0].filter.savedAt.$lt)).toBeCloseTo(1, 2);
		expect(deletes).toHaveLength(1);
		expect(ageDays(deletes[0].savedAt.$lt)).toBeCloseTo(90, 2);
	});

	it("deletes rows past the body window when the strip is refused, so the pruner can still free space", async () => {
		const { db, deletes } = fakeLog(true);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await pruneOldLogEntries(db);
		expect(deletes.map((d) => Math.round(ageDays(d.savedAt.$lt)))).toEqual([
			1, 90,
		]);
		expect(error.mock.calls[0][0]).toContain("stripping bodies failed");
		error.mockRestore();
	});
});
