/**
 * Objectives store fold — unit tests (Sprint 26a, deliverable A1).
 * Pure, no network, no MongoDB.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	appendEvent,
	foldStore,
	loadObjectivesStore,
} from "../src/objectives/store.js";
import type {
	CostEvent,
	GoalsFile,
	KpiEvent,
	TaskEvent,
} from "../src/objectives/types.js";

const T = (n: number) => `2026-06-25T0${n}:00:00.000Z`;

function findObj(
	roots: ReturnType<typeof foldStore>["objectives"],
	id: string,
) {
	const stack = [...roots];
	while (stack.length) {
		const o = stack.pop();
		if (!o) continue;
		if (o.id === id) return o;
		stack.push(...o.children);
	}
	return undefined;
}

describe("objectives store — task fold", () => {
	it("applies events in time order, last-write-wins per field, notes accumulate", () => {
		const taskEvents: TaskEvent[] = [
			{
				id: "TASK-1",
				at: T(1),
				by: "lead",
				title: "draft",
				objective: "OBJ-1",
				assignee: "alice",
				status: "open",
			},
			{
				id: "TASK-1",
				at: T(2),
				by: "alice",
				status: "in-progress",
				note: "started",
			},
			{
				id: "TASK-1",
				at: T(3),
				by: "alice",
				status: "completed",
				note: "done",
				assignee: "bob",
			},
		];
		const tree = foldStore({
			goals: { objectives: [] },
			taskEvents,
			kpiEvents: [],
			costEvents: [],
		});
		const t = tree.tasks[0];
		expect(t.status).toBe("completed");
		expect(t.assignee).toBe("bob");
		expect(t.title).toBe("draft");
		expect(t.notes).toEqual(["started", "done"]);
		expect(t.createdAt).toBe(T(1));
		expect(t.updatedAt).toBe(T(3));
		expect(t.createdBy).toBe("lead");
	});

	it("folds events regardless of file order (sorts by timestamp)", () => {
		const taskEvents: TaskEvent[] = [
			{ id: "TASK-1", at: T(3), by: "a", status: "completed" },
			{ id: "TASK-1", at: T(1), by: "a", title: "x", status: "open" },
			{ id: "TASK-1", at: T(2), by: "a", status: "in-progress" },
		];
		const tree = foldStore({
			goals: { objectives: [] },
			taskEvents,
			kpiEvents: [],
			costEvents: [],
		});
		expect(tree.tasks[0].status).toBe("completed");
	});

	it("defaults status to open and title to id", () => {
		const tree = foldStore({
			goals: { objectives: [] },
			taskEvents: [{ id: "TASK-9", at: T(1), by: "a" }],
			kpiEvents: [],
			costEvents: [],
		});
		expect(tree.tasks[0].status).toBe("open");
		expect(tree.tasks[0].title).toBe("TASK-9");
	});

	it("reports tasks whose objective does not resolve as orphans", () => {
		const goals: GoalsFile = {
			objectives: [
				{
					id: "OBJ-1",
					parent: null,
					title: "o",
					owner: "lead",
					status: "active",
					kpis: [],
				},
			],
		};
		const taskEvents: TaskEvent[] = [
			{ id: "T1", at: T(1), by: "a", objective: "OBJ-1" },
			{ id: "T2", at: T(1), by: "a", objective: "NOPE" },
		];
		const tree = foldStore({
			goals,
			taskEvents,
			kpiEvents: [],
			costEvents: [],
		});
		expect(tree.orphanTasks.map((t) => t.id)).toEqual(["T2"]);
		expect(findObj(tree.objectives, "OBJ-1")?.tasks.map((t) => t.id)).toEqual([
			"T1",
		]);
	});
});

describe("objectives store — cost roll-up", () => {
	const goals: GoalsFile = {
		objectives: [
			{
				id: "OBJ-1",
				parent: null,
				title: "root",
				owner: "lead",
				status: "active",
				budgetUsd: 10,
				kpis: [],
			},
			{
				id: "OBJ-1.1",
				parent: "OBJ-1",
				title: "child",
				owner: "alice",
				status: "active",
				budgetUsd: 4,
				kpis: [],
			},
		],
	};
	const taskEvents: TaskEvent[] = [
		{
			id: "T1",
			at: T(1),
			by: "a",
			objective: "OBJ-1.1",
			status: "in-progress",
		},
		{ id: "T2", at: T(1), by: "a", objective: "OBJ-1", status: "open" },
	];

	it("attributes task cost and rolls it up to ancestors", () => {
		const costEvents: CostEvent[] = [
			{ turn: 1, agent: "alice", at: T(2), alloc: { T1: 0.5 } },
			{ turn: 2, agent: "alice", at: T(3), alloc: { T1: 0.25, T2: 0.1 } },
		];
		const tree = foldStore({ goals, taskEvents, kpiEvents: [], costEvents });
		const child = findObj(tree.objectives, "OBJ-1.1");
		const root = findObj(tree.objectives, "OBJ-1");
		expect(child?.tasks.find((t) => t.id === "T1")?.costUsd).toBeCloseTo(0.75);
		expect(child?.costUsd).toBeCloseTo(0.75); // T1 only
		expect(root?.costUsd).toBeCloseTo(0.85); // T2 (0.1) + child (0.75)
	});

	it("adds objective-targeted cost (supervisor overhead) on top, propagating up", () => {
		const costEvents: CostEvent[] = [
			{ turn: 1, agent: "lead", at: T(2), alloc: { "OBJ-1": 0.4 } },
		];
		const tree = foldStore({ goals, taskEvents, kpiEvents: [], costEvents });
		expect(findObj(tree.objectives, "OBJ-1")?.costUsd).toBeCloseTo(0.4);
	});

	it("collects unattributable cost into overheadCostUsd", () => {
		const costEvents: CostEvent[] = [
			{ turn: 1, agent: "lead", at: T(2), alloc: { overhead: 0.3, T1: 0.2 } },
		];
		const tree = foldStore({ goals, taskEvents, kpiEvents: [], costEvents });
		expect(tree.overheadCostUsd).toBeCloseTo(0.3);
	});
});

describe("objectives store — KPI fold", () => {
	const goals: GoalsFile = {
		objectives: [
			{
				id: "OBJ-1",
				parent: null,
				title: "root",
				owner: "lead",
				status: "active",
				budgetUsd: 5,
				kpis: [
					{
						id: "K-rep",
						label: "coverage",
						owner: "lead",
						kind: "qualitative",
						source: "agent-reported",
					},
					{
						id: "K-cost",
						label: "cost",
						owner: "lead",
						kind: "quantitative",
						source: "auto-stat",
						metricKey: "objectiveCostUsd",
						target: 5,
						unit: "USD",
					},
					{
						id: "K-roll",
						label: "tasks done",
						owner: "lead",
						kind: "quantitative",
						source: "task-rollup",
					},
					{
						id: "K-auto",
						label: "files",
						owner: "lead",
						kind: "quantitative",
						source: "auto-stat",
						metricKey: "filesProduced",
					},
				],
			},
		],
	};
	const taskEvents: TaskEvent[] = [
		{ id: "T1", at: T(1), by: "a", objective: "OBJ-1", status: "completed" },
		{ id: "T2", at: T(1), by: "a", objective: "OBJ-1", status: "in-progress" },
	];

	it("takes the latest reported value and computes task-rollup + auto-stat", () => {
		const kpiEvents: KpiEvent[] = [
			{ kpi: "K-rep", value: "partial", by: "lead", at: T(1) },
			{ kpi: "K-rep", value: "met", by: "lead", at: T(2) },
		];
		const costEvents: CostEvent[] = [
			{ turn: 1, agent: "a", at: T(2), alloc: { T1: 1.2 } },
		];
		const tree = foldStore(
			{
				goals,
				taskEvents,
				kpiEvents,
				costEvents,
				autoStats: { filesProduced: 7 },
			},
			{ now: new Date(T(3)) },
		);
		const o = findObj(tree.objectives, "OBJ-1");
		const kpi = (id: string) => o?.kpis.find((k) => k.id === id);
		expect(kpi("K-rep")?.value).toBe("met");
		expect(kpi("K-rep")?.stale).toBe(false);
		expect(kpi("K-cost")?.value).toBeCloseTo(1.2); // reads rolled-up cost
		expect(kpi("K-roll")?.value).toBe("1 / 2");
		expect(kpi("K-auto")?.value).toBe(7);
	});

	it("flags a reported KPI as stale when unreported, pending, or aged out", () => {
		const kpiEvents: KpiEvent[] = [
			{ kpi: "K-rep", value: "pending", by: "lead", at: T(1) },
		];
		const fresh = foldStore({ goals, taskEvents, kpiEvents, costEvents: [] });
		expect(
			findObj(fresh.objectives, "OBJ-1")?.kpis.find((k) => k.id === "K-rep")
				?.stale,
		).toBe(true);

		// no event at all → stale + null value
		const none = foldStore({
			goals,
			taskEvents,
			kpiEvents: [],
			costEvents: [],
		});
		const k = findObj(none.objectives, "OBJ-1")?.kpis.find(
			(x) => x.id === "K-rep",
		);
		expect(k?.value).toBeNull();
		expect(k?.stale).toBe(true);

		// good value but aged beyond staleAfterMs
		const aged = foldStore(
			{
				goals,
				taskEvents,
				kpiEvents: [{ kpi: "K-rep", value: "met", by: "lead", at: T(1) }],
				costEvents: [],
			},
			{ now: new Date(T(5)), staleAfterMs: 60 * 60 * 1000 },
		);
		expect(
			findObj(aged.objectives, "OBJ-1")?.kpis.find((x) => x.id === "K-rep")
				?.stale,
		).toBe(true);
	});

	it("auto-stat with an unknown metric resolves to null", () => {
		const tree = foldStore({
			goals,
			taskEvents,
			kpiEvents: [],
			costEvents: [],
		});
		expect(
			findObj(tree.objectives, "OBJ-1")?.kpis.find((k) => k.id === "K-auto")
				?.value,
		).toBeNull();
	});
});

describe("objectives store — I/O", () => {
	it("appends events and folds them back from disk", async () => {
		const shared = mkdtempSync(join(tmpdir(), "obj-store-"));
		try {
			await appendEvent(shared, "tasks", {
				id: "T1",
				at: T(1),
				by: "alice",
				title: "do it",
				objective: "OBJ-1",
				status: "in-progress",
			});
			await appendEvent(shared, "tasks", {
				id: "T1",
				at: T(2),
				by: "alice",
				status: "completed",
			});
			await appendEvent(shared, "kpis", {
				kpi: "K1",
				value: "met",
				by: "lead",
				at: T(2),
			});
			await appendEvent(shared, "cost", {
				turn: 1,
				agent: "alice",
				at: T(2),
				alloc: { T1: 0.9 },
			});

			// No goals.json written → objectives empty, but tasks fold and orphan.
			const tree = await loadObjectivesStore(shared);
			expect(tree.tasks).toHaveLength(1);
			expect(tree.tasks[0].status).toBe("completed");
			expect(tree.tasks[0].costUsd).toBeCloseTo(0.9);
			expect(tree.orphanTasks).toHaveLength(1); // OBJ-1 not defined
		} finally {
			rmSync(shared, { recursive: true });
		}
	});

	it("returns an empty tree for a missing store", async () => {
		const tree = await loadObjectivesStore(
			join(tmpdir(), "does-not-exist-xyz"),
		);
		expect(tree.objectives).toEqual([]);
		expect(tree.tasks).toEqual([]);
	});
});
