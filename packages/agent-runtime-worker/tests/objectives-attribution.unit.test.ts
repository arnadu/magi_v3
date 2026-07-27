/**
 * Cost attribution — unit tests (Sprint 26a, deliverable B2; MongoDB-backed
 * since ADR-0019 — uses a fake in-memory ObjectivesRepository instead of a
 * real Mongo connection, so this stays a fast, dependency-free unit test).
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	attributeTurnCost,
	splitByWeight,
	tasksUpdatedInWindow,
	turnsSinceLastAttribution,
} from "../src/objectives/attribution.js";
import type { ObjectivesRepository } from "../src/objectives/repository.js";
import { foldStore } from "../src/objectives/store.js";
import type {
	AllocEvent,
	CostEvent,
	GoalsFile,
	KpiEvent,
	TaskEvent,
} from "../src/objectives/types.js";

const T = (h: number, m = 0) =>
	`2026-06-25T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

function createFakeObjectivesRepository(): ObjectivesRepository {
	let goals: GoalsFile = { objectives: [] };
	let hasGoals = false;
	const taskEvents: TaskEvent[] = [];
	const kpiEvents: KpiEvent[] = [];
	const costEvents: CostEvent[] = [];
	const allocEvents: AllocEvent[] = [];

	return {
		async readTree(_missionId, opts) {
			return foldStore({ goals, taskEvents, kpiEvents, costEvents }, opts);
		},
		async readGoals() {
			return goals;
		},
		async saveGoals(_missionId, g) {
			goals = g;
			hasGoals = true;
		},
		async appendTaskEvent(_missionId, e) {
			taskEvents.push(e);
		},
		async appendKpiEvent(_missionId, e) {
			kpiEvents.push(e);
		},
		async appendCostEvent(_missionId, e) {
			costEvents.push(e);
		},
		async appendAllocEvent(_missionId, e) {
			allocEvents.push(e);
		},
		async readTaskEvents() {
			return taskEvents;
		},
		async readCostEvents() {
			return costEvents;
		},
		async readAllocEvents() {
			return allocEvents;
		},
		async hasGoalsDoc() {
			return hasGoals;
		},
	};
}

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

describe("turnsSinceLastAttribution", () => {
	const events: CostEvent[] = [
		{ turn: 2, agent: "alice", at: T(1), alloc: { T1: 0.5 } },
		{ turn: 4, agent: "bob", at: T(2), alloc: { T2: 0.3 } },
	];
	it("counts turns since the agent's last cost event", () => {
		expect(turnsSinceLastAttribution(events, "alice", 5)).toBe(3);
	});
	it("returns currentTurn+1 when the agent never attributed", () => {
		expect(turnsSinceLastAttribution(events, "carol", 3)).toBe(4);
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
	const missionId = "m1";
	let repo: ObjectivesRepository;
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

	beforeEach(async () => {
		repo = createFakeObjectivesRepository();
		await repo.saveGoals(missionId, goals, "test");
	});

	it("attributes a turn's full cost to the single task updated that turn", async () => {
		await repo.appendTaskEvent(missionId, {
			id: "T1",
			at: T(1),
			by: "alice",
			objective: "OBJ-1",
			status: "in-progress",
		});
		const ev = await attributeTurnCost(repo, missionId, {
			agentId: "alice",
			turnNumber: 1,
			windowStart: new Date(T(0)),
			windowEnd: new Date(T(2)),
			lifetimeCostUsd: 0.4,
		});
		expect(ev?.alloc.T1).toBeCloseTo(0.4);
		const tree = await repo.readTree(missionId);
		expect(tree.objectives[0].costUsd).toBeCloseTo(0.4); // rolled up
	});

	it("carries cost over when no task is updated, then flushes it all on the next update", async () => {
		// Turn 1: no task updated → nothing attributed, cost carries.
		const none = await attributeTurnCost(repo, missionId, {
			agentId: "alice",
			turnNumber: 1,
			windowStart: new Date(T(0)),
			windowEnd: new Date(T(2)),
			lifetimeCostUsd: 0.3,
		});
		expect(none).toBeNull();

		// Turn 2: agent updates a task; lifetime now 0.5 → all 0.5 lands on T1.
		await repo.appendTaskEvent(missionId, {
			id: "T1",
			at: T(3),
			by: "alice",
			objective: "OBJ-1",
			status: "in-progress",
		});
		const ev = await attributeTurnCost(repo, missionId, {
			agentId: "alice",
			turnNumber: 2,
			windowStart: new Date(T(2, 30)),
			windowEnd: new Date(T(4)),
			lifetimeCostUsd: 0.5,
		});
		expect(ev?.alloc.T1).toBeCloseTo(0.5); // turn 1 + turn 2 cost
	});

	it("splits a turn's cost across multiple updated tasks by effort", async () => {
		await repo.appendTaskEvent(missionId, {
			id: "A",
			at: T(1),
			by: "alice",
			objective: "OBJ-1",
			status: "in-progress",
			effort: 3,
		});
		await repo.appendTaskEvent(missionId, {
			id: "B",
			at: T(1, 10),
			by: "alice",
			objective: "OBJ-1",
			status: "blocked",
			effort: 1,
		});
		const ev = await attributeTurnCost(repo, missionId, {
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
		const empty = createFakeObjectivesRepository(); // never seeded — no goals, no tasks
		const ev = await attributeTurnCost(empty, missionId, {
			agentId: "alice",
			turnNumber: 1,
			windowStart: new Date(T(0)),
			windowEnd: new Date(T(2)),
			lifetimeCostUsd: 1.0,
		});
		expect(ev).toBeNull();
	});

	it("uses an explicit allocate intent over task updates (the timesheet fallback)", async () => {
		// Agent updated a task, but also ran allocate → the intent wins.
		await repo.appendTaskEvent(missionId, {
			id: "T1",
			at: T(1),
			by: "alice",
			objective: "OBJ-1",
			status: "in-progress",
		});
		await repo.appendAllocEvent(missionId, {
			by: "alice",
			at: T(1, 30),
			key: { "OBJ-1": 70, overhead: 30 },
		});
		const ev = await attributeTurnCost(repo, missionId, {
			agentId: "alice",
			turnNumber: 1,
			windowStart: new Date(T(0)),
			windowEnd: new Date(T(2)),
			lifetimeCostUsd: 1.0,
		});
		expect(ev?.alloc["OBJ-1"]).toBeCloseTo(0.7);
		expect(ev?.alloc.overhead).toBeCloseTo(0.3);
		expect(ev?.alloc.T1).toBeUndefined(); // task split overridden
	});

	it("attributes a stale supervisor's balance to its owned objective", async () => {
		// alice owns OBJ-1, updates no task. Before STALE_TURNS it carries…
		const early = await attributeTurnCost(repo, missionId, {
			agentId: "alice",
			turnNumber: 1,
			windowStart: new Date(T(0)),
			windowEnd: new Date(T(2)),
			lifetimeCostUsd: 0.2,
		});
		expect(early).toBeNull();
		// …by turn 3 (>= STALE_TURNS) it lands on OBJ-1.
		const ev = await attributeTurnCost(repo, missionId, {
			agentId: "alice",
			turnNumber: 3,
			windowStart: new Date(T(2)),
			windowEnd: new Date(T(4)),
			lifetimeCostUsd: 0.6,
		});
		expect(ev?.alloc["OBJ-1"]).toBeCloseTo(0.6);
		const tree = await repo.readTree(missionId);
		expect(tree.objectives[0].costUsd).toBeCloseTo(0.6); // supervisor overhead on the objective
	});

	it("does not double-attribute across turns", async () => {
		await repo.appendTaskEvent(missionId, {
			id: "T1",
			at: T(1),
			by: "alice",
			objective: "OBJ-1",
			status: "in-progress",
		});
		await attributeTurnCost(repo, missionId, {
			agentId: "alice",
			turnNumber: 1,
			windowStart: new Date(T(0)),
			windowEnd: new Date(T(2)),
			lifetimeCostUsd: 0.4,
		});
		// Turn 2: another update, lifetime grew to 0.7 → only the new 0.3 attributed.
		await repo.appendTaskEvent(missionId, {
			id: "T1",
			at: T(3),
			by: "alice",
			status: "completed",
		});
		const ev2 = await attributeTurnCost(repo, missionId, {
			agentId: "alice",
			turnNumber: 2,
			windowStart: new Date(T(2, 30)),
			windowEnd: new Date(T(4)),
			lifetimeCostUsd: 0.7,
		});
		expect(ev2?.alloc.T1).toBeCloseTo(0.3);
		const tree = await repo.readTree(missionId);
		expect(tree.tasks[0].costUsd).toBeCloseTo(0.7); // 0.4 + 0.3, no double count
	});
});
