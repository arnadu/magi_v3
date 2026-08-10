/**
 * Objectives tools — replaces the four Bash skill scripts (ADR-0019).
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
	type KpiEvent,
	type TaskEvent,
	TaskStatusSchema,
} from "./types.js";

function ok(text: string): ToolResult {
	return { content: [{ type: "text", text: truncate(text) }] };
}
function err(text: string): ToolResult {
	return { content: [{ type: "text", text: truncate(text) }], isError: true };
}

const TASK_STATUSES = TaskStatusSchema.options;

export function createObjectivesTools(
	repo: ObjectivesRepository,
	missionId: string,
	agentId: string,
): MagiTool[] {
	const addTask: MagiTool = {
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

	const updateTask: MagiTool = {
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

	const recordKpi: MagiTool = {
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

	const allocate: MagiTool = {
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
			const raw = args.key as string;
			const key: Record<string, number> = {};
			for (const pair of raw.split(",")) {
				const idx = pair.indexOf(":");
				const target = idx >= 0 ? pair.slice(0, idx).trim() : "";
				const weight =
					idx >= 0 ? Number(pair.slice(idx + 1).trim()) : Number.NaN;
				if (!target || Number.isNaN(weight) || weight <= 0) {
					return err(
						`Allocate: invalid pair "${pair}" — expected target:weight with weight > 0 (e.g. TASK-1:60)`,
					);
				}
				key[target] = (key[target] ?? 0) + weight;
			}
			if (Object.keys(key).length === 0) {
				return err("Allocate: key produced no targets");
			}
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

	return [addTask, updateTask, recordKpi, allocate];
}
