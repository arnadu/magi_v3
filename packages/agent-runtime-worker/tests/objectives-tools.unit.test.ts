/**
 * Objectives tools — unit tests (ADR-0019). Replaces objectives-skill.unit.test.ts
 * (the four Bash scripts these tools replace) — same behavioral coverage
 * against a fake in-memory ObjectivesRepository instead of real Bash/fs.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { ObjectivesRepository } from "../src/objectives/repository.js";
import { foldStore } from "../src/objectives/store.js";
import { createObjectivesTools } from "../src/objectives/tools.js";
import type {
	AllocEvent,
	CostEvent,
	GoalsFile,
	KpiEvent,
	TaskEvent,
} from "../src/objectives/types.js";

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

const missionId = "m1";
const agentId = "alice";

function toolByName(
	tools: ReturnType<typeof createObjectivesTools>,
	name: string,
) {
	const t = tools.find((t) => t.name === name);
	if (!t) throw new Error(`tool ${name} not found`);
	return t;
}

describe("objectives tools", () => {
	let repo: ObjectivesRepository;
	let tools: ReturnType<typeof createObjectivesTools>;

	beforeEach(() => {
		repo = createFakeObjectivesRepository();
		tools = createObjectivesTools(repo, missionId, agentId);
	});

	describe("AddTask", () => {
		it("appends a create event the fold reads back", async () => {
			const addTask = toolByName(tools, "AddTask");
			const res = await addTask.execute("t1", { title: "Pull prices" });
			expect(res.isError).toBeFalsy();
			const id = res.content[0].text;
			expect(id).toMatch(/^TASK-/);

			const tree = await repo.readTree(missionId);
			expect(tree.orphanTasks[0].title).toBe("Pull prices");
			expect(tree.orphanTasks[0].assignee).toBe(agentId);
			expect(tree.orphanTasks[0].status).toBe("open");
		});

		it("rejects an invalid status", async () => {
			const addTask = toolByName(tools, "AddTask");
			const res = await addTask.execute("t1", {
				title: "x",
				status: "not-a-status",
			});
			expect(res.isError).toBe(true);
		});
	});

	describe("UpdateTask", () => {
		it("changes only the fields passed; effort lands in the raw event", async () => {
			const updateTask = toolByName(tools, "UpdateTask");
			const res = await updateTask.execute("t1", {
				id: "TASK-abc",
				status: "in-progress",
				effort: 3,
			});
			expect(res.isError).toBeFalsy();

			const events = await repo.readTaskEvents(missionId);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				id: "TASK-abc",
				status: "in-progress",
				effort: 3,
				by: agentId,
			});
			expect(events[0].title).toBeUndefined();
		});

		it("rejects an invalid status (contract enforced tool-side)", async () => {
			const updateTask = toolByName(tools, "UpdateTask");
			const res = await updateTask.execute("t1", {
				id: "TASK-abc",
				status: "nope",
			});
			expect(res.isError).toBe(true);
			expect(await repo.readTaskEvents(missionId)).toHaveLength(0);
		});
	});

	describe("RecordKpi", () => {
		it("accepts a numeric value with a note and does not touch task events", async () => {
			const recordKpi = toolByName(tools, "RecordKpi");
			const res = await recordKpi.execute("t1", {
				kpi: "K-num",
				value: 38,
				note: "so far",
			});
			expect(res.isError).toBeFalsy();
			expect(await repo.readTaskEvents(missionId)).toHaveLength(0);
		});

		it("records a KPI value visible in the folded tree for its owning objective", async () => {
			await repo.saveGoals(
				missionId,
				{
					objectives: [
						{
							id: "OBJ-1",
							parent: null,
							title: "root",
							owner: agentId,
							status: "active",
							kpis: [
								{
									id: "K1",
									label: "coverage",
									owner: agentId,
									kind: "quantitative",
									source: "agent-reported",
								},
							],
						},
					],
				},
				"test",
			);
			const recordKpi = toolByName(tools, "RecordKpi");
			const res = await recordKpi.execute("t1", { kpi: "K1", value: "38" });
			expect(res.isError).toBeFalsy();
			expect(res.content[0].text).toContain("K1 = 38");

			const tree = await repo.readTree(missionId);
			expect(tree.objectives[0].kpis[0].value).toBe(38); // numeric coercion
		});
	});

	describe("Allocate", () => {
		it("appends an allocation intent the attribution reads", async () => {
			const allocate = toolByName(tools, "Allocate");
			const res = await allocate.execute("t1", {
				key: "TASK-1:60,overhead:40",
			});
			expect(res.isError).toBeFalsy();

			const events = await repo.readAllocEvents(missionId);
			expect(events).toHaveLength(1);
			expect(events[0].key).toEqual({ "TASK-1": 60, overhead: 40 });
			expect(events[0].by).toBe(agentId);
		});

		it("rejects a malformed key", async () => {
			const allocate = toolByName(tools, "Allocate");
			const res = await allocate.execute("t1", { key: "not-a-valid-key" });
			expect(res.isError).toBe(true);
			expect(await repo.readAllocEvents(missionId)).toHaveLength(0);
		});
	});
});
