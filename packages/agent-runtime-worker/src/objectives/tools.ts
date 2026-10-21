/**
 * Objectives tools — replaced the four Bash skill scripts (ADR-0019).
 *
 * Agent Bash subprocesses deliberately receive no MONGODB_URI (existing
 * isolation model: a forked shell child gets only PATH and HOME) — so a Bash
 * script cannot write to Mongo. These tools run in-process in the orchestrator
 * (which already holds the connection), one per script:
 * task-add.sh → AddTask, task-update.sh → UpdateTask, record-kpi.sh →
 * RecordKpi, allocate.sh → Allocate. Same parameters, same validation, same
 * stdout-style confirmation text agents already expect from the skill.
 */

import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { MagiTool, ToolResult } from "../tools.js";
import { truncate } from "../tools.js";
import type { ObjectivesRepository } from "./repository.js";
import {
	type AllocEvent,
	type FoldedObjective,
	type KpiEvent,
	type TaskEvent,
	TaskStatusSchema,
} from "./types.js";

function findObjective(
	roots: FoldedObjective[],
	id: string,
): FoldedObjective | undefined {
	const stack = [...roots];
	while (stack.length) {
		const o = stack.pop();
		if (!o) break;
		if (o.id === id) return o;
		stack.push(...o.children);
	}
	return undefined;
}

function ok(text: string): ToolResult {
	return { content: [{ type: "text", text: truncate(text) }] };
}
function err(text: string): ToolResult {
	return { content: [{ type: "text", text: truncate(text) }], isError: true };
}

const TASK_STATUSES = TaskStatusSchema.options;

/** Identities that may touch any task or KPI: the operator and the mission copilot (its tools act for the operator). */
const PRIVILEGED = new Set(["user", "mission-copilot"]);
/** An allocation target: a task id, an objective id or "overhead" — never a prototype key. */
const ALLOC_TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const MAX_ALLOC_TARGETS = 50;

// Ownership (OB5): a task can be updated by its assignee, its creator, the
// owner of its objective, or a privileged identity; a KPI value can be
// recorded by the KPI's owner or a privileged identity. Everyone else gets
// a tool error rather than a silent write into someone else's record.
async function taskWriteDenied(
	repo: ObjectivesRepository,
	missionId: string,
	agentId: string,
	taskId: string,
): Promise<string | null> {
	if (PRIVILEGED.has(agentId)) return null;
	const tree = await repo.readTree(missionId);
	const task = tree.tasks.find((t) => t.id === taskId);
	if (!task) return `unknown task "${taskId}"`;
	if (task.assignee === agentId || task.createdBy === agentId) return null;
	const objectiveOwner = task.objective
		? findObjective(tree.objectives, task.objective)?.owner
		: undefined;
	if (objectiveOwner === agentId) return null;
	return `task "${taskId}" is assigned to ${task.assignee ?? "nobody"} (created by ${task.createdBy}); you may only update your own tasks or those under an objective you own`;
}
async function kpiWriteDenied(
	repo: ObjectivesRepository,
	missionId: string,
	agentId: string,
	kpiId: string,
): Promise<string | null> {
	const goals = await repo.readGoals(missionId);
	const def = goals.objectives
		.flatMap((o) => o.kpis)
		.find((k) => k.id === kpiId);
	if (!def) return `unknown KPI "${kpiId}"`;
	if (PRIVILEGED.has(agentId) || def.owner === agentId) return null;
	return `KPI "${kpiId}" is owned by ${def.owner}; only its owner records values`;
}

async function taskExists(
	repo: ObjectivesRepository,
	missionId: string,
	id: string,
): Promise<boolean> {
	const tree = await repo.readTree(missionId);
	return tree.tasks.some((t) => t.id === id);
}

/**
 * "target:weight,…" → a null-prototype map (a target named "__proto__" or
 * "constructor" must be a plain key, never a prototype write — OB6); targets
 * are slugs (a task id, an objective id or "overhead"), weights finite and > 0.
 */
function parseAllocationKey(
	raw: string,
): { key: Record<string, number> } | { error: string } {
	const key: Record<string, number> = Object.create(null);
	const pairs = raw.split(",");
	if (pairs.length > MAX_ALLOC_TARGETS) {
		return { error: `at most ${MAX_ALLOC_TARGETS} targets per call` };
	}
	for (const pair of pairs) {
		const idx = pair.indexOf(":");
		const target = idx >= 0 ? pair.slice(0, idx).trim() : "";
		const weight = idx >= 0 ? Number(pair.slice(idx + 1).trim()) : Number.NaN;
		if (
			!ALLOC_TARGET_RE.test(target) ||
			!Number.isFinite(weight) ||
			weight <= 0
		) {
			return {
				error: `invalid pair "${pair}" — expected target:weight with a task/objective id or "overhead" and weight > 0 (e.g. TASK-1:60)`,
			};
		}
		key[target] = (key[target] ?? 0) + weight;
	}
	if (Object.keys(key).length === 0)
		return { error: "key produced no targets" };
	return { key };
}

/** What every objectives tool acts for: one agent in one mission. */
interface ObjectivesToolDeps {
	repo: ObjectivesRepository;
	missionId: string;
	agentId: string;
}

function addTaskTool({
	repo,
	missionId,
	agentId,
}: ObjectivesToolDeps): MagiTool {
	return {
		name: "AddTask",
		description:
			"Add a new task to the objectives store. Defaults: assignee = you, status = open, id auto-generated. Prints the new task id.",
		parameters: Type.Object({
			id: Type.Optional(
				Type.String({
					description:
						"Explicit task id (default: auto-generated TASK-xxxxxxxx)",
				}),
			),
			title: Type.String({ description: "Task title" }),
			objective: Type.Optional(
				Type.String({ description: "Objective id this task belongs to" }),
			),
			assignee: Type.Optional(
				Type.String({ description: "Assignee agent id (default: you)" }),
			),
			status: Type.Optional(
				Type.String({
					description: `Initial status (default: open). One of: ${TASK_STATUSES.join(", ")}`,
				}),
			),
			priority: Type.Optional(Type.String()),
			deadline: Type.Optional(Type.String()),
			budgetUsd: Type.Optional(Type.Number()),
			note: Type.Optional(Type.String()),
		}),
		async execute(_id, args) {
			const status = (args.status as string | undefined) ?? "open";
			if (!TASK_STATUSES.includes(status as (typeof TASK_STATUSES)[number])) {
				return err(
					`AddTask: invalid status "${status}" (one of: ${TASK_STATUSES.join(", ")})`,
				);
			}
			const id =
				(args.id as string | undefined) || `TASK-${randomUUID().slice(0, 8)}`;
			if (args.id && (await taskExists(repo, missionId, id))) {
				return err(
					`AddTask: task "${id}" already exists — use UpdateTask to change it`,
				);
			}
			const event: TaskEvent = {
				id,
				at: new Date().toISOString(),
				by: agentId,
				title: args.title as string,
				objective: (args.objective as string | undefined) ?? null,
				assignee: (args.assignee as string | undefined) ?? agentId,
				status: status as TaskEvent["status"],
				...(args.priority !== undefined
					? { priority: args.priority as string }
					: {}),
				...(args.deadline !== undefined
					? { deadline: args.deadline as string }
					: {}),
				...(args.budgetUsd !== undefined
					? { budgetUsd: args.budgetUsd as number }
					: {}),
				...(args.note !== undefined ? { note: args.note as string } : {}),
			};
			try {
				await repo.appendTaskEvent(missionId, event);
				return ok(id);
			} catch (e) {
				return err(`AddTask: failed to record task — ${(e as Error).message}`);
			}
		},
	};
}

function updateTaskTool({
	repo,
	missionId,
	agentId,
}: ObjectivesToolDeps): MagiTool {
	return {
		name: "UpdateTask",
		description:
			"Update a task in the objectives store. Only the fields you pass are changed (last-write-wins); note is appended to the task's notes. effort is a relative per-turn weight used by cost attribution.",
		parameters: Type.Object({
			id: Type.String({ description: "Task id to update" }),
			status: Type.Optional(
				Type.String({
					description: `New status. One of: ${TASK_STATUSES.join(", ")}`,
				}),
			),
			assignee: Type.Optional(Type.String()),
			priority: Type.Optional(Type.String()),
			deadline: Type.Optional(Type.String()),
			budgetUsd: Type.Optional(Type.Number()),
			effort: Type.Optional(
				Type.Number({
					description:
						"Relative weight for this turn's cost attribution (default 1)",
				}),
			),
			note: Type.Optional(Type.String()),
		}),
		async execute(_id, args) {
			const status = args.status as string | undefined;
			if (
				status &&
				!TASK_STATUSES.includes(status as (typeof TASK_STATUSES)[number])
			) {
				return err(
					`UpdateTask: invalid status "${status}" (one of: ${TASK_STATUSES.join(", ")})`,
				);
			}
			const denied = await taskWriteDenied(
				repo,
				missionId,
				agentId,
				args.id as string,
			);
			if (denied) return err(`UpdateTask: ${denied}`);
			const event: TaskEvent = {
				id: args.id as string,
				at: new Date().toISOString(),
				by: agentId,
				...(status !== undefined
					? { status: status as TaskEvent["status"] }
					: {}),
				...(args.assignee !== undefined
					? { assignee: args.assignee as string }
					: {}),
				...(args.priority !== undefined
					? { priority: args.priority as string }
					: {}),
				...(args.deadline !== undefined
					? { deadline: args.deadline as string }
					: {}),
				...(args.budgetUsd !== undefined
					? { budgetUsd: args.budgetUsd as number }
					: {}),
				...(args.effort !== undefined ? { effort: args.effort as number } : {}),
				...(args.note !== undefined ? { note: args.note as string } : {}),
			};
			try {
				await repo.appendTaskEvent(missionId, event);
				return ok(`UpdateTask: ${event.id} updated`);
			} catch (e) {
				return err(
					`UpdateTask: failed to record update — ${(e as Error).message}`,
				);
			}
		},
	};
}

function recordKpiTool({
	repo,
	missionId,
	agentId,
}: ObjectivesToolDeps): MagiTool {
	return {
		name: "RecordKpi",
		description:
			"Record a value for a KPI you own (the latest value wins on read). A numeric value is stored as a number; otherwise as text (e.g. met/partial/unmet).",
		parameters: Type.Object({
			kpi: Type.String({ description: "KPI id" }),
			value: Type.Union([Type.String(), Type.Number()], {
				description: "The value to record",
			}),
			note: Type.Optional(Type.String()),
		}),
		async execute(_id, args) {
			const raw = args.value;
			const value =
				typeof raw === "number"
					? raw
					: (() => {
							const s = String(raw);
							const asNum = Number(s);
							return s.trim() !== "" && !Number.isNaN(asNum) ? asNum : s;
						})();
			const denied = await kpiWriteDenied(
				repo,
				missionId,
				agentId,
				args.kpi as string,
			);
			if (denied) return err(`RecordKpi: ${denied}`);
			const event: KpiEvent = {
				kpi: args.kpi as string,
				value,
				by: agentId,
				at: new Date().toISOString(),
				...(args.note !== undefined ? { note: args.note as string } : {}),
			};
			try {
				await repo.appendKpiEvent(missionId, event);
				return ok(`RecordKpi: ${event.kpi} = ${value}`);
			} catch (e) {
				return err(`RecordKpi: failed to record — ${(e as Error).message}`);
			}
		},
	};
}

function allocateTool({
	repo,
	missionId,
	agentId,
}: ObjectivesToolDeps): MagiTool {
	return {
		name: "Allocate",
		description:
			'Explicit cost-allocation timesheet (fallback) — use ONLY when your mental map flags unattributed cost; normally cost is attributed automatically from your UpdateTask calls. Split your unattributed spend across targets by relative weight, e.g. "TASK-1:60,overhead:40". A target is a task id, an objective id, or the literal "overhead".',
		parameters: Type.Object({
			key: Type.String({
				description:
					'Comma-separated target:weight pairs, e.g. "TASK-1:60,overhead:40"',
			}),
		}),
		async execute(_id, args) {
			const parsed = parseAllocationKey(args.key as string);
			if ("error" in parsed) return err(`Allocate: ${parsed.error}`);
			const key = parsed.key;
			const event: AllocEvent = {
				by: agentId,
				at: new Date().toISOString(),
				key,
			};
			try {
				await repo.appendAllocEvent(missionId, event);
				return ok(`Allocate: recorded ${JSON.stringify(key)}`);
			} catch (e) {
				return err(`Allocate: failed to record — ${(e as Error).message}`);
			}
		},
	};
}

export function createObjectivesTools(
	repo: ObjectivesRepository,
	missionId: string,
	agentId: string,
): MagiTool[] {
	const deps = { repo, missionId, agentId };
	return [
		addTaskTool(deps),
		updateTaskTool(deps),
		recordKpiTool(deps),
		allocateTool(deps),
	];
}
