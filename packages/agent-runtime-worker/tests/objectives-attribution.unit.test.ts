/**
 * Cost attribution — unit tests (Sprint 26a, deliverable B2).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	attributeTurnCost,
	splitByWeight,
	tasksUpdatedInWindow,
} from "../src/objectives/attribution.js";
import { appendEvent, loadObjectivesStore } from "../src/objectives/store.js";
import type { GoalsFile, TaskEvent } from "../src/objectives/types.js";

const T = (h: number, m = 0) =>
	`2026-06-25T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

describe("tasksUpdatedInWindow", () => {
	const events: TaskEvent[] = [
		{ id: "A", at: T(1), by: "alice", status: "in-progress", effort: 3 },
		{ id: "A", at: T(1, 30), by: "alice", status: "completed" }, // bare update, same turn
		{ id: "B", at: T(1, 15), by: "alice", status: "blocked" }, // no effort → 1
		{ id: "C", at: T(1), by: "bob", status: "open" }, // other agent
		{ id: "D", at: T(9), by: "alice", status: "open" }, // outside window
	];

	it("keeps only this agent's tasks within the window, max effort per task", () => {
		const w = tasksUpdatedInWindow(events, "alice", T(0), T(2));
		expect([...w.entries()].sort()).toEqual([
			["A", 3], // max(3, bare→1)
			["B", 1],
		]);
	});
});

describe("splitByWeight", () => {
	it("splits proportionally", () => {
		const alloc = splitByWeight(
			1.0,
			new Map([
				["A", 3],
				["B", 1],
			]),
		);
		expect(alloc.A).toBeCloseTo(0.75);
		expect(alloc.B).toBeCloseTo(0.25);
	});
	it("splits evenly with default weights", () => {
		const alloc = splitByWeight(
			1.0,
			new Map([
				["A", 1],
				["B", 1],
			]),
		);
		expect(alloc.A).toBeCloseTo(0.5);
		expect(alloc.B).toBeCloseTo(0.5);
	});
});

describe("attributeTurnCost — carry-over + flush", () => {
	let shared: string;
	const goals: GoalsFile = {
		objectives: [
			{
				id: "OBJ-1",
				parent: null,
				title: "root",
				owner: "alice",
				status: "active",
				kpis: [],
			},
		],
	};

	beforeEach(() => {
		shared = mkdtempSync(join(tmpdir(), "attr-"));
		mkdirSync(join(shared, "objectives"), { recursive: true });
		writeFileSync(
			join(shared, "objectives", "goals.json"),
			JSON.stringify(goals),
		);
	});
	afterEach(() => rmSync(shared, { recursive: true, force: true }));

	it("attributes a turn's full cost to the single task updated that turn", async () => {
		await appendEvent(shared, "tasks", {
			id: "T1",
			at: T(1),
			by: "alice",
			objective: "OBJ-1",
			status: "in-progress",
		});
		const ev = await attributeTurnCost(shared, {
			agentId: "alice",
			turnNumber: 1,
			windowStart: new Date(T(0)),
			windowEnd: new Date(T(2)),
			lifetimeCostUsd: 0.4,
		});
		expect(ev?.alloc.T1).toBeCloseTo(0.4);
		const tree = await loadObjectivesStore(shared);
		expect(tree.objectives[0].costUsd).toBeCloseTo(0.4); // rolled up
	});

	it("carries cost over when no task is updated, then flushes it all on the next update", async () => {
		// Turn 1: no task updated → nothing attributed, cost carries.
		const none = await attributeTurnCost(shared, {
			agentId: "alice",
			turnNumber: 1,
			windowStart: new Date(T(0)),
			windowEnd: new Date(T(2)),
			lifetimeCostUsd: 0.3,
		});
		expect(none).toBeNull();

		// Turn 2: agent updates a task; lifetime now 0.5 → all 0.5 lands on T1.
		await appendEvent(shared, "tasks", {
			id: "T1",
			at: T(3),
			by: "alice",
			objective: "OBJ-1",
			status: "in-progress",
		});
		const ev = await attributeTurnCost(shared, {
			agentId: "alice",
			turnNumber: 2,
			windowStart: new Date(T(2, 30)),
			windowEnd: new Date(T(4)),
			lifetimeCostUsd: 0.5,
		});
		expect(ev?.alloc.T1).toBeCloseTo(0.5); // turn 1 + turn 2 cost
	});

	it("splits a turn's cost across multiple updated tasks by effort", async () => {
		await appendEvent(shared, "tasks", {
			id: "A",
			at: T(1),
			by: "alice",
			objective: "OBJ-1",
			status: "in-progress",
			effort: 3,
		});
		await appendEvent(shared, "tasks", {
			id: "B",
			at: T(1, 10),
			by: "alice",
			objective: "OBJ-1",
			status: "blocked",
			effort: 1,
		});
		const ev = await attributeTurnCost(shared, {
			agentId: "alice",
			turnNumber: 1,
			windowStart: new Date(T(0)),
			windowEnd: new Date(T(2)),
			lifetimeCostUsd: 0.8,
		});
		expect(ev?.alloc.A).toBeCloseTo(0.6);
		expect(ev?.alloc.B).toBeCloseTo(0.2);
	});

	it("returns null when the mission has no task store", async () => {
		rmSync(join(shared, "objectives"), { recursive: true, force: true });
		const ev = await attributeTurnCost(shared, {
			agentId: "alice",
			turnNumber: 1,
			windowStart: new Date(T(0)),
			windowEnd: new Date(T(2)),
			lifetimeCostUsd: 1.0,
		});
		expect(ev).toBeNull();
	});

	it("does not double-attribute across turns", async () => {
		await appendEvent(shared, "tasks", {
			id: "T1",
			at: T(1),
			by: "alice",
			objective: "OBJ-1",
			status: "in-progress",
		});
		await attributeTurnCost(shared, {
			agentId: "alice",
			turnNumber: 1,
			windowStart: new Date(T(0)),
			windowEnd: new Date(T(2)),
			lifetimeCostUsd: 0.4,
		});
		// Turn 2: another update, lifetime grew to 0.7 → only the new 0.3 attributed.
		await appendEvent(shared, "tasks", {
			id: "T1",
			at: T(3),
			by: "alice",
			status: "completed",
		});
		const ev2 = await attributeTurnCost(shared, {
			agentId: "alice",
			turnNumber: 2,
			windowStart: new Date(T(2, 30)),
			windowEnd: new Date(T(4)),
			lifetimeCostUsd: 0.7,
		});
		expect(ev2?.alloc.T1).toBeCloseTo(0.3);
		const tree = await loadObjectivesStore(shared);
		expect(tree.tasks[0].costUsd).toBeCloseTo(0.7); // 0.4 + 0.3, no double count
	});
});
