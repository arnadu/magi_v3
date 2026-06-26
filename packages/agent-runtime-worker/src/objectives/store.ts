/**
 * Objectives store — fold + I/O (Sprint 26a, deliverable A1).
 *
 * `foldStore` is pure: it takes the parsed `goals.json` plus the append-only
 * event arrays and returns the current-state tree (task status, KPI values,
 * costs rolled up). `loadObjectivesStore` reads the files from a directory and
 * folds them. `appendEvent` is the only writer helper — used by the daemon
 * (cost attribution, B2) and tests; agent skill scripts append directly in JS.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type AllocEvent,
	AllocEventSchema,
	type CostEvent,
	CostEventSchema,
	type FoldedKpi,
	type FoldedObjective,
	type FoldedTask,
	type FoldedTree,
	type GoalsFile,
	GoalsFileSchema,
	type KpiDef,
	type KpiEvent,
	KpiEventSchema,
	type ObjectiveDef,
	OVERHEAD_BUCKET,
	STORE_FILES,
	type TaskEvent,
	TaskEventSchema,
	type TaskStatus,
} from "./types.js";

export interface FoldInput {
	goals: GoalsFile;
	taskEvents: TaskEvent[];
	kpiEvents: KpiEvent[];
	costEvents: CostEvent[];
	/** auto-stat metric values, keyed by `metricKey` (daemon-supplied). */
	autoStats?: Record<string, number>;
}

export interface FoldOptions {
	/** Current time for staleness checks (defaults to now). */
	now?: Date;
	/** A reported KPI older than this (ms) is stale. Omit to disable age-based staleness. */
	staleAfterMs?: number;
}

const REPORTED_SOURCES = new Set([
	"agent-reported",
	"copilot-assessment",
	"manual",
]);

/** A KPI value that signals "not done yet" regardless of its age. */
function valueNeedsAttention(value: string | number | null): boolean {
	if (value === null) return true;
	return typeof value === "string" && /pending|unmet|partial/i.test(value);
}

// ---------------------------------------------------------------------------
// Task fold: group events by id, apply in time order (last-write-wins per
// field; notes accumulate).
// ---------------------------------------------------------------------------

function foldTasks(
	events: TaskEvent[],
	costByTarget: Map<string, number>,
): Map<string, FoldedTask> {
	// Stable sort by timestamp, falling back to original order for equal times.
	const ordered = events
		.map((e, i) => ({ e, i }))
		.sort((a, b) => (a.e.at < b.e.at ? -1 : a.e.at > b.e.at ? 1 : a.i - b.i))
		.map((x) => x.e);

	const tasks = new Map<string, FoldedTask>();
	for (const ev of ordered) {
		let t = tasks.get(ev.id);
		if (!t) {
			t = {
				id: ev.id,
				objective: ev.objective ?? null,
				title: ev.title ?? ev.id,
				assignee: ev.assignee ?? null,
				status: ev.status ?? "open",
				costUsd: 0,
				notes: [],
				createdAt: ev.at,
				updatedAt: ev.at,
				createdBy: ev.by,
			};
			tasks.set(ev.id, t);
		}
		if (ev.title !== undefined) t.title = ev.title;
		if (ev.objective !== undefined) t.objective = ev.objective;
		if (ev.assignee !== undefined) t.assignee = ev.assignee;
		if (ev.status !== undefined) t.status = ev.status;
		if (ev.priority !== undefined) t.priority = ev.priority;
		if (ev.deadline !== undefined) t.deadline = ev.deadline;
		if (ev.budgetUsd !== undefined) t.budgetUsd = ev.budgetUsd;
		if (ev.note !== undefined) t.notes.push(ev.note);
		t.updatedAt = ev.at;
	}
	for (const t of tasks.values()) t.costUsd = costByTarget.get(t.id) ?? 0;
	return tasks;
}

// ---------------------------------------------------------------------------
// Cost fold: sum every alloc across all cost events into a per-target total.
// ---------------------------------------------------------------------------

function foldCosts(events: CostEvent[]): Map<string, number> {
	const totals = new Map<string, number>();
	for (const ev of events) {
		for (const [target, usd] of Object.entries(ev.alloc)) {
			totals.set(target, (totals.get(target) ?? 0) + usd);
		}
	}
	return totals;
}

// ---------------------------------------------------------------------------
// KPI fold: latest value per kpi id (reported sources only).
// ---------------------------------------------------------------------------

interface LatestKpi {
	value: string | number;
	at: string;
	by: string;
}
function foldKpiValues(events: KpiEvent[]): Map<string, LatestKpi> {
	const latest = new Map<string, LatestKpi>();
	for (const ev of events) {
		const prev = latest.get(ev.kpi);
		if (!prev || ev.at >= prev.at)
			latest.set(ev.kpi, { value: ev.value, at: ev.at, by: ev.by });
	}
	return latest;
}

// ---------------------------------------------------------------------------
// Main fold
// ---------------------------------------------------------------------------

export function foldStore(
	input: FoldInput,
	opts: FoldOptions = {},
): FoldedTree {
	const now = opts.now ?? new Date();
	const autoStats = input.autoStats ?? {};

	const costByTarget = foldCosts(input.costEvents);
	const taskMap = foldTasks(input.taskEvents, costByTarget);
	const allTasks = [...taskMap.values()];
	const latestKpi = foldKpiValues(input.kpiEvents);

	// Index objectives and resolve the parent/child tree.
	const defById = new Map<string, ObjectiveDef>();
	for (const o of input.goals.objectives) defById.set(o.id, o);

	// Build folded nodes (without KPIs yet — KPI fold needs rolled-up cost).
	const nodeById = new Map<string, FoldedObjective>();
	for (const o of input.goals.objectives) {
		nodeById.set(o.id, {
			id: o.id,
			parent: o.parent ?? null,
			title: o.title,
			description: o.description,
			owner: o.owner,
			status: o.status,
			budgetUsd: o.budgetUsd ?? 0,
			costUsd: 0,
			kpis: [],
			tasks: [],
			children: [],
		});
	}

	// Attach tasks to their objective; collect orphans.
	const orphanTasks: FoldedTask[] = [];
	for (const t of allTasks) {
		const node = t.objective ? nodeById.get(t.objective) : undefined;
		if (node) node.tasks.push(t);
		else orphanTasks.push(t);
	}

	// Link children; top-level = parent null or parent not found.
	const roots: FoldedObjective[] = [];
	for (const node of nodeById.values()) {
		const parent = node.parent ? nodeById.get(node.parent) : undefined;
		if (parent) parent.children.push(node);
		else roots.push(node);
	}

	// Roll up cost: post-order so children are summed before parents.
	const rollUp = (node: FoldedObjective): number => {
		let sum = node.tasks.reduce((a, t) => a + t.costUsd, 0);
		for (const c of node.children) sum += rollUp(c);
		node.costUsd = sum;
		return sum;
	};
	for (const r of roots) rollUp(r);

	// Objective-targeted alloc (supervisor overhead) sits on top of the task
	// roll-up and propagates to ancestors — done before KPIs read costUsd.
	for (const node of nodeById.values()) {
		const direct = costByTarget.get(node.id);
		if (direct) addObjectiveDirectCost(node, direct, nodeById);
	}

	// Now fold KPIs (objectiveCostUsd reflects the final rolled-up + overhead cost).
	const subtreeTasks = (node: FoldedObjective): FoldedTask[] => {
		const out = [...node.tasks];
		for (const c of node.children) out.push(...subtreeTasks(c));
		return out;
	};
	for (const node of nodeById.values()) {
		const def = defById.get(node.id);
		if (!def) continue;
		node.kpis = def.kpis.map((k) =>
			foldKpi(k, { node, latestKpi, autoStats, now, opts, subtreeTasks }),
		);
	}

	// Overhead = cost alloc'd to targets that are neither a known task nor objective.
	let overheadCostUsd = 0;
	for (const [target, usd] of costByTarget) {
		if (!taskMap.has(target) && !nodeById.has(target)) overheadCostUsd += usd;
	}

	return {
		objectives: roots,
		tasks: allTasks,
		orphanTasks,
		overheadCostUsd,
	};
}

/** Add cost allocated directly to an objective (overhead), propagating to ancestors. */
function addObjectiveDirectCost(
	node: FoldedObjective,
	usd: number,
	nodeById: Map<string, FoldedObjective>,
): void {
	let cur: FoldedObjective | undefined = node;
	while (cur) {
		cur.costUsd += usd;
		cur = cur.parent ? nodeById.get(cur.parent) : undefined;
	}
}

function foldKpi(
	def: KpiDef,
	ctx: {
		node: FoldedObjective;
		latestKpi: Map<string, LatestKpi>;
		autoStats: Record<string, number>;
		now: Date;
		opts: FoldOptions;
		subtreeTasks: (n: FoldedObjective) => FoldedTask[];
	},
): FoldedKpi {
	const { node, latestKpi, autoStats, now, opts, subtreeTasks } = ctx;
	let value: string | number | null = null;
	let updatedAt: string | undefined;
	let updatedBy: string | undefined;
	let stale = false;

	if (def.source === "task-rollup") {
		const tasks = subtreeTasks(node);
		const total = tasks.length;
		const done = tasks.filter((t) => t.status === "completed").length;
		value = `${done} / ${total}`;
	} else if (def.source === "auto-stat") {
		// `objectiveCostUsd` is the rolled-up cost; other metrics come from the daemon.
		value =
			def.metricKey === "objectiveCostUsd"
				? Number(node.costUsd.toFixed(4))
				: def.metricKey && def.metricKey in autoStats
					? autoStats[def.metricKey]
					: null;
	} else if (REPORTED_SOURCES.has(def.source)) {
		const latest = latestKpi.get(def.id);
		if (latest) {
			value = latest.value;
			updatedAt = latest.at;
			updatedBy = latest.by;
		}
		// Stale: never reported, value signals not-done, or aged out.
		stale = valueNeedsAttention(value);
		if (!stale && updatedAt && opts.staleAfterMs !== undefined) {
			stale = now.getTime() - new Date(updatedAt).getTime() > opts.staleAfterMs;
		}
	}

	return { ...def, value, updatedAt, updatedBy, stale };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function objectivesDir(sharedDir: string): string {
	return join(sharedDir, "objectives");
}

async function readJsonl<T>(
	path: string,
	parse: (o: unknown) => T,
): Promise<T[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw e;
	}
	const out: T[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		// Append-only logs are written by agent skill scripts; one malformed or
		// schema-invalid line must not make the whole store unreadable (it would
		// break the mental-map sync for every agent). Skip and warn instead.
		try {
			out.push(parse(JSON.parse(trimmed)));
		} catch (err) {
			console.warn(
				`[objectives] skipping malformed line in ${path}: ${(err as Error).message}`,
			);
		}
	}
	return out;
}

/** Load and fold the objectives store from a mission's shared dir. */
export async function loadObjectivesStore(
	sharedDir: string,
	opts: FoldOptions & { autoStats?: Record<string, number> } = {},
): Promise<FoldedTree> {
	const dir = objectivesDir(sharedDir);

	let goals: GoalsFile;
	try {
		goals = GoalsFileSchema.parse(
			JSON.parse(await readFile(join(dir, STORE_FILES.goals), "utf8")),
		);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT")
			goals = { objectives: [] };
		else throw e;
	}

	const [taskEvents, kpiEvents, costEvents] = await Promise.all([
		readJsonl(join(dir, STORE_FILES.tasks), (o) => TaskEventSchema.parse(o)),
		readJsonl(join(dir, STORE_FILES.kpis), (o) => KpiEventSchema.parse(o)),
		readJsonl(join(dir, STORE_FILES.cost), (o) => CostEventSchema.parse(o)),
	]);

	return foldStore(
		{ goals, taskEvents, kpiEvents, costEvents, autoStats: opts.autoStats },
		opts,
	);
}

/** Append one validated event to a store log (the only writer helper). */
export async function appendEvent(
	sharedDir: string,
	file: "tasks" | "kpis" | "cost" | "alloc",
	event: TaskEvent | KpiEvent | CostEvent | AllocEvent,
): Promise<void> {
	const path = join(objectivesDir(sharedDir), STORE_FILES[file]);
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

/** Raw task events (no fold) — for cost attribution's turn-window scan. */
export async function loadTaskEvents(sharedDir: string): Promise<TaskEvent[]> {
	return readJsonl(join(objectivesDir(sharedDir), STORE_FILES.tasks), (o) =>
		TaskEventSchema.parse(o),
	);
}

/** Raw cost events (no fold) — for computing already-attributed totals. */
export async function loadCostEvents(sharedDir: string): Promise<CostEvent[]> {
	return readJsonl(join(objectivesDir(sharedDir), STORE_FILES.cost), (o) =>
		CostEventSchema.parse(o),
	);
}

/** Raw allocation-intent events (no fold) — for the `allocate` timesheet fallback. */
export async function loadAllocEvents(
	sharedDir: string,
): Promise<AllocEvent[]> {
	return readJsonl(join(objectivesDir(sharedDir), STORE_FILES.alloc), (o) =>
		AllocEventSchema.parse(o),
	);
}

/** The authored objective tree + KPI definitions (or empty when absent). */
export async function loadGoals(sharedDir: string): Promise<GoalsFile> {
	try {
		return GoalsFileSchema.parse(
			JSON.parse(
				await readFile(
					join(objectivesDir(sharedDir), STORE_FILES.goals),
					"utf8",
				),
			),
		);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT")
			return { objectives: [] };
		throw e;
	}
}

export { OVERHEAD_BUCKET };
export type { TaskStatus };
