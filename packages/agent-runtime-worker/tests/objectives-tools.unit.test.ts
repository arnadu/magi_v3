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
			// A task must exist before it can be updated (OB5): seed it first.
			await repo.appendTaskEvent(missionId, {
				id: "TASK-abc",
				at: "2026-01-01T00:00:00.000Z",
				by: agentId,
				title: "seed",
				assignee: agentId,
			});
			const updateTask = toolByName(tools, "UpdateTask");
			const res = await updateTask.execute("t1", {
				id: "TASK-abc",
				status: "in-progress",
				effort: 3,
			});
			expect(res.isError).toBeFalsy();

			const events = (await repo.readTaskEvents(missionId)).slice(1);
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
			// The KPI must be defined and owned by this agent (OB5).
			await repo.saveGoals(
				missionId,
				{
					objectives: [
						{
							id: "OBJ-num",
							parent: null,
							title: "root",
							owner: agentId,
							status: "active",
							kpis: [
								{
									id: "K-num",
									label: "n",
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

describe("ownership and input safety (OB5/OB6)", () => {
	const goals: GoalsFile = {
		objectives: [
			{
				id: "OBJ-1",
				parent: null,
				title: "Objective",
				owner: "supervisor",
				status: "active",
				kpis: [
					{
						id: "KPI-1",
						label: "k",
						owner: "analyst",
						kind: "quantitative",
						source: "agent-reported",
					},
				],
			},
		],
	};

	async function setup() {
		const repo = createFakeObjectivesRepository();
		await repo.saveGoals("m1", goals, "user");
		const tool = (agent: string, name: string) => {
			const t = createObjectivesTools(repo, "m1", agent).find(
				(x) => x.name === name,
			);
			if (!t) throw new Error(name);
			return t;
		};
		return { repo, tool };
	}

	it("UpdateTask: a stranger is refused, the assignee / creator / objective owner / copilot are not", async () => {
		const { tool } = await setup();
		const idRes = await tool("analyst", "AddTask").execute("c", {
			title: "T",
			objective: "OBJ-1",
			assignee: "worker",
		});
		const id = idRes.content[0].text;
		const refused = await tool("stranger", "UpdateTask").execute("c", {
			id,
			status: "completed",
		});
		expect(refused.isError).toBe(true);
		expect(refused.content[0].text).toMatch(/assigned to worker/);
		for (const who of ["worker", "analyst", "supervisor", "mission-copilot"]) {
			const r = await tool(who, "UpdateTask").execute("c", { id, note: who });
			expect(r.isError, who).toBeFalsy();
		}
		const unknown = await tool("worker", "UpdateTask").execute("c", {
			id: "TASK-nope",
			note: "x",
		});
		expect(unknown.isError).toBe(true);
	});

	it("AddTask with an existing id is refused instead of silently updating", async () => {
		const { tool } = await setup();
		await tool("analyst", "AddTask").execute("c", { id: "TASK-1", title: "a" });
		const dup = await tool("worker", "AddTask").execute("c", {
			id: "TASK-1",
			title: "hijack",
		});
		expect(dup.isError).toBe(true);
		expect(dup.content[0].text).toMatch(/already exists/);
	});

	it("RecordKpi: only the KPI's owner (or the copilot) records a value; unknown KPIs are refused", async () => {
		const { tool } = await setup();
		const no = await tool("worker", "RecordKpi").execute("c", {
			kpi: "KPI-1",
			value: 1,
		});
		expect(no.isError).toBe(true);
		expect(no.content[0].text).toMatch(/owned by analyst/);
		const yes = await tool("analyst", "RecordKpi").execute("c", {
			kpi: "KPI-1",
			value: 1,
		});
		expect(yes.isError).toBeFalsy();
		const cp = await tool("mission-copilot", "RecordKpi").execute("c", {
			kpi: "KPI-1",
			value: "met",
		});
		expect(cp.isError).toBeFalsy();
		const ghost = await tool("analyst", "RecordKpi").execute("c", {
			kpi: "KPI-9",
			value: 1,
		});
		expect(ghost.isError).toBe(true);
	});

	it("Allocate refuses prototype keys and malformed targets, and never writes to Object.prototype", async () => {
		const { tool, repo } = await setup();
		for (const key of [
			"__proto__:50,overhead:50",
			"TASK-1:Infinity",
			"a b:1",
			":5",
		]) {
			const r = await tool("analyst", "Allocate").execute("c", { key });
			expect(r.isError, key).toBe(true);
		}
		expect(({} as Record<string, unknown>).__proto__).toBe(Object.prototype);
		const ok = await tool("analyst", "Allocate").execute("c", {
			key: "TASK-1:60,overhead:40",
		});
		expect(ok.isError).toBeFalsy();
		const [ev] = await repo.readAllocEvents("m1");
		expect(ev.key).toEqual({ "TASK-1": 60, overhead: 40 });
		// A target that happens to be a prototype property name is a plain key
		// on the null-prototype map, not a write to Object.prototype.
		const ctor = await tool("analyst", "Allocate").execute("c", {
			key: "constructor:1",
		});
		expect(ctor.isError).toBeFalsy();
		expect(Object.keys((await repo.readAllocEvents("m1"))[1].key)).toEqual([
			"constructor",
		]);
		expect(typeof ({} as Record<string, unknown>).constructor).toBe("function");
	});
});
