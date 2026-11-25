/**
 * Platform tasks (operation `mission.platform-task`): housekeeping on a mission machine that the
 * mission's agents must not be able to do. The kinds are code shipped in the mission image
 * (`/usr/local/sbin/magi-task`); a mission only chooses which kinds run, how often, and with what
 * parameters, all checked here and again by the wrapper.
 *
 * The list lives in the mission document's own `platformTasks` field, beside the structured
 * config but outside it: no config editor (the cockpit, either copilot) writes it. It is copied
 * from the template when a mission is created, and otherwise changed only by the platform admin.
 */
import { parse } from "yaml";
import { z } from "zod";

export const PLATFORM_TASK_KINDS = ["git-mirror"] as const;
export type PlatformTaskKind = (typeof PLATFORM_TASK_KINDS)[number];

/** Where the tasks' outputs live on the machine (the image creates it for the platform user). */
export const PLATFORM_TASK_ROOT = "/var/lib/magi/reference";

/** A fixed host keeps the fetch off the private network without a resolver check. */
export const GITHUB_REPO_URL_RE =
	/^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const PLATFORM_TASK_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,100}$/;

const GitMirrorTaskSchema = z
	.object({
		kind: z.literal("git-mirror"),
		/** The folder under PLATFORM_TASK_ROOT; a slug. */
		name: z.string().regex(PLATFORM_TASK_NAME_RE),
		params: z
			.object({
				url: z
					.string()
					.regex(
						GITHUB_REPO_URL_RE,
						"must be https://github.com/<owner>/<repo>",
					),
				branch: z
					.string()
					.regex(BRANCH_RE)
					.refine((b) => !b.startsWith("-") && !b.includes(".."), {
						message: "must not start with '-' or contain '..'",
					}),
			})
			.strict(),
		/** Minutes between runs, after the run at boot. */
		everyMinutes: z.number().int().min(5).max(1440).default(15),
	})
	.strict();

export const PlatformTaskSchema = z.discriminatedUnion("kind", [
	GitMirrorTaskSchema,
]);
export type PlatformTask = z.infer<typeof PlatformTaskSchema>;

export const PlatformTasksSchema = z
	.array(PlatformTaskSchema)
	.max(10)
	.refine((ts) => new Set(ts.map((t) => t.name)).size === ts.length, {
		message: "task names must be unique",
	});

/** Validates a mission's platform tasks; throws with the schema's message when invalid. */
export function parsePlatformTasks(raw: unknown): PlatformTask[] {
	if (raw === undefined || raw === null) return [];
	return PlatformTasksSchema.parse(raw);
}

/** The `platformTasks` section of a team YAML, unvalidated (the daemon's runner validates it). */
export function rawPlatformTasksYaml(yamlContent: string): unknown {
	const raw = parse(yamlContent) as { platformTasks?: unknown } | null;
	return raw?.platformTasks;
}

/** The `platformTasks` section of a team YAML (a template, or a local TEAM_CONFIG file). */
export function parsePlatformTasksYaml(yamlContent: string): PlatformTask[] {
	return parsePlatformTasks(rawPlatformTasksYaml(yamlContent));
}

/**
 * Which agents of the mission may read the repository's open security alerts (code scanning,
 * Dependabot) through the control plane (operation `security.read-alerts`). Admin-only like
 * `platformTasks`: a top-level field of the mission document no config editor writes. The
 * control plane also requires the mission's owner to be a platform admin.
 */
export const SecurityAlertsSchema = z
	.object({
		agents: z.array(z.string().regex(PLATFORM_TASK_NAME_RE)).min(1).max(10),
	})
	.strict();
export type SecurityAlerts = z.infer<typeof SecurityAlertsSchema>;

/** The agents allowed to read security alerts; none when the field is absent. Throws when invalid. */
export function parseSecurityAlerts(raw: unknown): SecurityAlerts | undefined {
	if (raw === undefined || raw === null) return undefined;
	return SecurityAlertsSchema.parse(raw);
}

/** The `securityAlerts` section of a team YAML, unvalidated. */
export function rawSecurityAlertsYaml(yamlContent: string): unknown {
	const raw = parse(yamlContent) as { securityAlerts?: unknown } | null;
	return raw?.securityAlerts;
}
