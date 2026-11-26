/**
 * The rules that make a task a work order (ADR-0038): its required skills
 * exist for the assignee, its check script cannot be rigged, its terms are
 * changed only by whoever set them, starting it hands over its skills, and
 * completing it meets its finish line. What lives in other layers (the skill
 * tiers, safe paths, the agent's shell) comes in through `WorkOrderEnv`, built
 * by the agent loop (`agent-runner-work-orders.ts`).
 */

import { readFileSync } from "node:fs";
import {
	MAX_TASK_CHECK_ARG_CHARS,
	MAX_TASK_CHECK_ARGS,
	MAX_TASK_DONE_WHEN_CHARS,
	MAX_TASK_INSTRUCTIONS_CHARS,
	MAX_TASK_SKILLS,
	type TaskCheck,
	type TaskWorkOrder,
	TaskWorkOrderSchema,
} from "@magi/agent-config";
import { Type } from "@sinclair/typebox";
import type { FoldedTask } from "./types.js";

/** The daemon-injected mission copilot (ADR-0016): not in the team roster, every skill offered. */
const MISSION_COPILOT = "mission-copilot";

/** What the work-order rules need from the agent's turn. */
export interface WorkOrderEnv {
	/**
	 * Skills a task may require, name → SKILL.md path: the team and platform
	 * tiers only. An agent-authored skill can be rewritten by agents, so it
	 * never sets a standard.
	 */
	operatorSkills(): ReadonlyMap<string, string>;
	/** A team agent's disabled skills; null when it is not an agent of this mission. */
	disabledSkillsFor(agentId: string): readonly string[] | null;
	/** A check script's absolute path inside the read-only skill tiers, or why not. */
	resolveCheckScript(script: string): { path: string } | { error: string };
	/** Run a shell command as the calling agent, in its workdir, with its clean environment. */
	runAsCaller(
		command: string,
		timeoutSec: number,
		signal?: AbortSignal,
	): Promise<{ ok: boolean; output: string }>;
}

export const CHECK_TIMEOUT_SEC = 120;
/** The check's output kept in the completion note. */
export const CHECK_OUTPUT_CHARS = 2000;
/** Skill text handed over on start; above it, paths only (the tool output cap is 20,000). */
export const HANDOVER_MAX_CHARS = 18_000;
/** A completion note for a task with a finish line and no check. */
export const MIN_COMPLETION_NOTE_CHARS = 40;

/** Why `skills` cannot be required of `assignee`, or null. */
export function requiredSkillsError(
	env: WorkOrderEnv,
	skills: readonly string[],
	assignee: string | null,
): string | null {
	if (skills.length === 0) return null;
	if (!assignee) return "a task with required skills needs an assignee";
	const disabled =
		assignee === MISSION_COPILOT ? [] : env.disabledSkillsFor(assignee);
	if (disabled === null)
		return `"${assignee}" is not an agent of this mission, so it cannot be required to follow skills`;
	const known = env.operatorSkills();
	for (const name of skills) {
		if (!known.has(name))
			return `"${name}" is not a team or platform skill (only those can be required: agents can rewrite their own)`;
		if (disabled.includes(name)) return `"${name}" is disabled for ${assignee}`;
	}
	return null;
}

/** Single-quote one shell word. */
function shellQuote(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Validate a work order's references before it is recorded. */
export function workOrderError(
	env: WorkOrderEnv,
	order: TaskWorkOrder,
	assignee: string | null,
): string | null {
	if (order.skills) {
		const e = requiredSkillsError(env, order.skills, assignee);
		if (e) return e;
	}
	if (order.check) {
		const r = env.resolveCheckScript(order.check.script);
		if ("error" in r) return r.error;
	}
	return null;
}

const TERMS = ["doneWhen", "check", "skills"] as const;

/**
 * The finish line and the standard are set by whoever assigned the work: an
 * assignee that did not create the task may not change them.
 */
export function termsChangeDenied(
	task: FoldedTask,
	agentId: string,
	privileged: boolean,
	objectiveOwner: string | undefined,
	changed: TaskWorkOrder,
): string | null {
	if (privileged || task.createdBy === agentId || objectiveOwner === agentId)
		return null;
	const touched = TERMS.filter((k) => changed[k] !== undefined);
	if (touched.length === 0) return null;
	return `only the task's creator (${task.createdBy}), its objective's owner or the mission copilot may change ${touched.join(", ")}`;
}

/** The required skills' text for an agent starting the task. */
export function skillHandover(
	env: WorkOrderEnv,
	skills: readonly string[],
): string {
	if (skills.length === 0) return "";
	const known = env.operatorSkills();
	const parts: string[] = [];
	const paths: string[] = [];
	let total = 0;
	for (const name of skills) {
		const path = known.get(name);
		if (!path) {
			parts.push(`(skill "${name}" is no longer installed)`);
			continue;
		}
		paths.push(`${name}: ${path}`);
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch (e) {
			text = `(could not read ${path}: ${(e as Error).message})`;
		}
		total += text.length;
		parts.push(`===== Skill ${name} (${path}) =====\n${text}`);
	}
	const head =
		"This task must follow the skills below; do the work to their standard.";
	if (total > HANDOVER_MAX_CHARS) {
		return `${head} They are too long to include here: read each in full now.\n${paths.join("\n")}`;
	}
	return `${head}\n\n${parts.join("\n\n")}`;
}

/** Run a task's check as the caller. Passed: exit 0. */
export async function runCheck(
	env: WorkOrderEnv,
	check: TaskCheck,
	signal?: AbortSignal,
): Promise<{ passed: boolean; output: string }> {
	const r = env.resolveCheckScript(check.script);
	if ("error" in r) return { passed: false, output: r.error };
	const command = ["bash", r.path, ...(check.args ?? [])]
		.map(shellQuote)
		.join(" ");
	const res = await env.runAsCaller(command, CHECK_TIMEOUT_SEC, signal);
	return { passed: res.ok, output: res.output.slice(0, CHECK_OUTPUT_CHARS) };
}

/** The work-order parameters, shared by AddTask and UpdateTask. */
export const WORK_ORDER_PARAMS = {
	instructions: Type.Optional(
		Type.String({
			maxLength: MAX_TASK_INSTRUCTIONS_CHARS,
			description:
				"What to achieve and why, the inputs with their paths, and the limits. The assignee sees it with the task every turn.",
		}),
	),
	doneWhen: Type.Optional(
		Type.String({
			maxLength: MAX_TASK_DONE_WHEN_CHARS,
			description:
				"The finish line, stated so it can be checked. Completing the task then needs a note saying how each condition was met, unless a check script decides it.",
		}),
	),
	check: Type.Optional(
		Type.Object(
			{
				script: Type.String({
					description:
						"<skill>/<path inside it> of a team or platform skill, e.g. alert-triage/scripts/check_first_pass.sh. Run as the agent completing the task; exit 0 means done.",
				}),
				args: Type.Optional(
					Type.Array(Type.String({ maxLength: MAX_TASK_CHECK_ARG_CHARS }), {
						maxItems: MAX_TASK_CHECK_ARGS,
					}),
				),
			},
			{ additionalProperties: false },
		),
	),
	skills: Type.Optional(
		Type.Array(Type.String(), {
			maxItems: MAX_TASK_SKILLS,
			description:
				"Team or platform skills the work must follow; their text is handed to the assignee when it starts the task.",
		}),
	),
};

/** The work-order fields of a tool call, validated, or an error. */
export function parseWorkOrder(
	args: Record<string, unknown>,
): { order: TaskWorkOrder } | { error: string } {
	const r = TaskWorkOrderSchema.safeParse({
		instructions: args.instructions,
		doneWhen: args.doneWhen,
		check: args.check,
		skills: args.skills,
	});
	if (!r.success)
		return {
			error: r.error.issues
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; "),
		};
	const order: TaskWorkOrder = {};
	for (const [k, v] of Object.entries(r.data))
		if (v !== undefined) (order as Record<string, unknown>)[k] = v;
	return { order };
}

/** Checks a work order's skill and script references; refuses them where they cannot be checked. */
export function referencesError(
	workOrders: WorkOrderEnv | undefined,
	order: TaskWorkOrder,
	assignee: string | null,
): string | null {
	if (!order.skills && !order.check) return null;
	if (!workOrders)
		return "required skills and check scripts cannot be validated here";
	return workOrderError(workOrders, order, assignee);
}

/**
 * Completion against the finish line: the note to record, or why the task
 * cannot be completed yet.
 */
export async function completionNote(
	task: FoldedTask,
	order: TaskWorkOrder,
	args: Record<string, unknown>,
	agentId: string,
	privileged: boolean,
	workOrders: WorkOrderEnv | undefined,
	signal: AbortSignal | undefined,
): Promise<{ note?: string } | { error: string }> {
	const note = (args.note as string | undefined)?.trim() ?? "";
	const override = (args.override as string | undefined)?.trim();
	const check = order.check ?? task.check;
	const doneWhen = order.doneWhen ?? task.doneWhen;
	if (override !== undefined) {
		if (!privileged)
			return {
				error:
					"only the operator or the mission copilot may complete a task without meeting its finish line",
			};
		if (!override) return { error: "override needs a reason" };
		return {
			note: [note, `Completed by override (${agentId}): ${override}`]
				.filter(Boolean)
				.join("\n"),
		};
	}
	if (check) {
		if (!workOrders)
			return { error: "this task has a check, which cannot be run here" };
		const r = await runCheck(workOrders, check, signal);
		if (!r.passed)
			return {
				error: `the task's check (${check.script}) did not pass, so it stays ${task.status}:\n${r.output}`,
			};
		return {
			note: [note, `Check passed (${check.script}):\n${r.output}`]
				.filter(Boolean)
				.join("\n"),
		};
	}
	if (doneWhen && note.length < MIN_COMPLETION_NOTE_CHARS)
		return {
			error: `this task is done when: "${doneWhen}". Complete it with a note saying how each condition was met, with paths.`,
		};
	return note ? { note } : {};
}
