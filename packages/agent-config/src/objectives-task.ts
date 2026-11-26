/**
 * A task as a work order: what to do, when it is done, and the skills it must
 * follow. Shared by the objectives store (the daemon) and, later, the
 * templates that carry a mission's allocated tasks, so both agree on one shape.
 */
import { z } from "zod";

export const MAX_TASK_INSTRUCTIONS_CHARS = 2000;
export const MAX_TASK_DONE_WHEN_CHARS = 500;
export const MAX_TASK_SKILLS = 6;
export const MAX_TASK_CHECK_ARGS = 8;
export const MAX_TASK_CHECK_ARG_CHARS = 200;

/** A skill name: one slug, as the skill tiers name their directories. */
export const TASK_SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * `<skill>/<path inside it>`, e.g. `alert-triage/scripts/check_first_pass.sh`.
 * Resolved by the daemon inside the read-only team or platform skill tiers only.
 */
export const TASK_CHECK_SCRIPT_RE =
	/^[a-z0-9][a-z0-9-]{0,63}\/[A-Za-z0-9_.][A-Za-z0-9_./-]{0,199}$/;

const noNul = (s: string) => !s.includes("\0");

export const TaskCheckSchema = z
	.object({
		script: z
			.string()
			.regex(TASK_CHECK_SCRIPT_RE, "must be <skill>/<path inside the skill>")
			.refine((s) => !s.split("/").includes(".."), "must not contain ..")
			.refine(noNul, "must not contain a NUL byte"),
		args: z
			.array(
				z
					.string()
					.max(MAX_TASK_CHECK_ARG_CHARS)
					.refine(noNul, "must not contain a NUL byte"),
			)
			.max(MAX_TASK_CHECK_ARGS)
			.optional(),
	})
	.strict();
export type TaskCheck = z.infer<typeof TaskCheckSchema>;

export const TaskWorkOrderSchema = z.object({
	instructions: z.string().max(MAX_TASK_INSTRUCTIONS_CHARS).optional(),
	doneWhen: z.string().max(MAX_TASK_DONE_WHEN_CHARS).optional(),
	check: TaskCheckSchema.optional(),
	skills: z
		.array(z.string().regex(TASK_SKILL_NAME_RE, "must be a skill name"))
		.max(MAX_TASK_SKILLS)
		.optional(),
});
export type TaskWorkOrder = z.infer<typeof TaskWorkOrderSchema>;
