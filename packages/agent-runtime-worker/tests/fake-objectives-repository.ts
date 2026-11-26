/** An in-memory ObjectivesRepository over the real fold, for the objectives tool tests. */
import type { ObjectivesRepository } from "../src/objectives/repository.js";
import { foldStore } from "../src/objectives/store.js";
import type {
	AllocEvent,
	CostEvent,
	GoalsFile,
	KpiEvent,
	TaskEvent,
} from "../src/objectives/types.js";

export function createFakeObjectivesRepository(): ObjectivesRepository {
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
