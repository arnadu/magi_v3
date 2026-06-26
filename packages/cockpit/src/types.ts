// Mirrors the folded shape returned by the monitor `GET /objectives` endpoint
// (agent-runtime-worker/src/objectives/types.ts FoldedTree). Kept structural so
// the Objectives panel can render the live store unchanged once auth is wired.

export type TaskStatus =
	| "open"
	| "in-progress"
	| "blocked"
	| "completed"
	| "deferred"
	| "cancelled";

export interface FoldedKpi {
	id: string;
	label: string;
	owner: string;
	kind: "quantitative" | "qualitative";
	source:
		| "auto-stat"
		| "task-rollup"
		| "agent-reported"
		| "copilot-assessment"
		| "manual";
	target?: number;
	unit?: string;
	value: string | number | null;
	stale: boolean;
}

export interface FoldedTask {
	id: string;
	objective: string | null;
	title: string;
	assignee: string | null;
	status: TaskStatus;
	costUsd: number;
	budgetUsd?: number;
}

export interface FoldedObjective {
	id: string;
	parent: string | null;
	title: string;
	owner: string;
	status: "proposed" | "active" | "achieved" | "abandoned";
	budgetUsd: number;
	costUsd: number;
	kpis: FoldedKpi[];
	tasks: FoldedTask[];
	children: FoldedObjective[];
}

export interface FoldedTree {
	objectives: FoldedObjective[];
	tasks: FoldedTask[];
	orphanTasks: FoldedTask[];
	overheadCostUsd: number;
}
