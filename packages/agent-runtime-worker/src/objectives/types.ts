/**
 * Objectives store — schema (Sprint 26a, deliverable A1).
 *
 * The store is plain files under `sharedDir/objectives/`:
 *   - `goals.json`   — the authored objective tree + KPI *definitions* (low-churn)
 *   - `tasks.jsonl`  — append-only task events (one JSON object per line)
 *   - `kpis.jsonl`   — append-only KPI *value* events (reported sources only)
 *   - `cost.jsonl`   — append-only cost-attribution events (written by the daemon)
 *
 * Agent skill scripts only ever **append** an event (cannot clobber concurrent
 * writers); the daemon/UI **fold** the logs to current state on read. This file
 * defines both the on-disk shapes (Zod-validated) and the folded output shape.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// KPI definitions (live in goals.json)
// ---------------------------------------------------------------------------

export const KpiSourceSchema = z.enum([
	"auto-stat", // computed at fold time from agentTurnStats (e.g. cost, files)
	"task-rollup", // computed at fold time from linked task completion
	"agent-reported", // owner agent publishes a value via `record-kpi`
	"copilot-assessment", // copilot KPI skill writes a value
	"manual", // operator sets it
]);
export type KpiSource = z.infer<typeof KpiSourceSchema>;

export const KpiKindSchema = z.enum(["quantitative", "qualitative"]);
export type KpiKind = z.infer<typeof KpiKindSchema>;

export const KpiDefSchema = z.object({
	id: z.string(),
	label: z.string(),
	owner: z.string(), // agentId reminded to keep it current
	kind: KpiKindSchema,
	source: KpiSourceSchema,
	target: z.number().optional(), // quantitative goal
	unit: z.string().optional(),
	metricKey: z.string().optional(), // auto-stat: which metric to read
	rubric: z.string().optional(), // qualitative: how it's judged
});
export type KpiDef = z.infer<typeof KpiDefSchema>;

// ---------------------------------------------------------------------------
// Objective definitions (goals.json)
// ---------------------------------------------------------------------------

export const ObjectiveStatusSchema = z.enum([
	"proposed",
	"active",
	"achieved",
	"abandoned",
]);
export type ObjectiveStatus = z.infer<typeof ObjectiveStatusSchema>;

export const ObjectiveDefSchema = z.object({
	id: z.string(),
	parent: z.string().nullable().default(null), // null = top-level; else parent id
	title: z.string(),
	description: z.string().optional(),
	owner: z.string(), // supervisor agent accountable for status + KPIs
	status: ObjectiveStatusSchema.default("active"),
	budgetUsd: z.number().optional(), // authored at any node
	kpis: z.array(KpiDefSchema).default([]),
});
export type ObjectiveDef = z.infer<typeof ObjectiveDefSchema>;

export const GoalsFileSchema = z.object({
	objectives: z.array(ObjectiveDefSchema).default([]),
});
export type GoalsFile = z.infer<typeof GoalsFileSchema>;

// ---------------------------------------------------------------------------
// Append-only event shapes
// ---------------------------------------------------------------------------

export const TaskStatusSchema = z.enum([
	"open",
	"in-progress",
	"blocked",
	"completed",
	"deferred",
	"cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * One task event (tasks.jsonl). `id`/`at`/`by` are always present; any other
 * field present overrides the prior folded value (last-write-wins), except
 * `note`, which is appended to the task's `notes[]`. `effort` is a per-update
 * weight consumed by cost attribution (B2) — it is not folded into task state.
 */
export const TaskEventSchema = z.object({
	id: z.string(),
	at: z.string(), // ISO timestamp
	by: z.string(), // agentId or "user"
	title: z.string().optional(),
	objective: z.string().nullable().optional(),
	assignee: z.string().nullable().optional(),
	status: TaskStatusSchema.optional(),
	priority: z.string().optional(),
	deadline: z.string().optional(),
	budgetUsd: z.number().optional(),
	effort: z.number().optional(),
	note: z.string().optional(),
});
export type TaskEvent = z.infer<typeof TaskEventSchema>;

/** One KPI value event (kpis.jsonl) — reported sources only. Latest wins. */
export const KpiEventSchema = z.object({
	kpi: z.string(),
	value: z.union([z.string(), z.number()]),
	by: z.string(),
	at: z.string(),
	note: z.string().optional(),
});
export type KpiEvent = z.infer<typeof KpiEventSchema>;

/**
 * One cost-attribution event (cost.jsonl), written by the daemon at turn end.
 * `alloc` maps a target id → USD; a target is normally a taskId, but may be an
 * objectiveId (supervisor overhead) or a reserved bucket like `"overhead"`.
 */
export const CostEventSchema = z.object({
	turn: z.number(),
	agent: z.string(),
	at: z.string(),
	alloc: z.record(z.string(), z.number()),
});
export type CostEvent = z.infer<typeof CostEventSchema>;

// ---------------------------------------------------------------------------
// Folded (current-state) output
// ---------------------------------------------------------------------------

export interface FoldedTask {
	id: string;
	objective: string | null;
	title: string;
	assignee: string | null;
	status: TaskStatus;
	priority?: string;
	deadline?: string;
	budgetUsd?: number;
	costUsd: number; // attributed (≈ — turn-granular)
	notes: string[];
	createdAt: string;
	updatedAt: string;
	createdBy: string;
}

export interface FoldedKpi extends KpiDef {
	value: string | number | null; // current value (folded or computed); null = not yet known
	updatedAt?: string;
	updatedBy?: string;
	stale: boolean; // reported KPI needing a refresh (no value, pending/unmet, or aged out)
}

export interface FoldedObjective
	extends Omit<ObjectiveDef, "kpis" | "budgetUsd"> {
	budgetUsd: number; // 0 if unset
	costUsd: number; // rolled up (own tasks + descendant objectives)
	kpis: FoldedKpi[];
	tasks: FoldedTask[]; // tasks directly under this objective
	children: FoldedObjective[]; // sub-objectives
}

export interface FoldedTree {
	objectives: FoldedObjective[]; // top-level (parent === null / unresolved)
	tasks: FoldedTask[]; // all tasks, flat
	orphanTasks: FoldedTask[]; // tasks whose `objective` does not resolve
	overheadCostUsd: number; // cost alloc'd to buckets that are neither task nor objective
}

/** The reserved cost-allocation bucket for unattributable spend. */
export const OVERHEAD_BUCKET = "overhead";

/** Store file names under `sharedDir/objectives/`. */
export const STORE_FILES = {
	goals: "goals.json",
	tasks: "tasks.jsonl",
	kpis: "kpis.jsonl",
	cost: "cost.jsonl",
} as const;
