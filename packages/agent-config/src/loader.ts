import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { ZodError, z } from "zod";

// ---------------------------------------------------------------------------
// Schemas — single source of truth for both validation and TypeScript types
// ---------------------------------------------------------------------------

/**
 * Per-agent limit thresholds (Sprint 24). All optional.
 *
 * Hard fields (max*) abort the current turn when exceeded — opt-in, no default,
 * so existing missions are never aborted by a surprise cap. Soft fields (warn*)
 * route an advisory alert to the copilot without interrupting the turn; they
 * carry conservative built-in defaults when omitted (set to 0 to disable).
 */
export const LimitsSchema = z
	.object({
		maxLlmCallsPerTurn: z.number().int().positive().optional(),
		maxCostPerTurnUsd: z.number().positive().optional(),
		maxLifetimeCostUsd: z.number().positive().optional(),
		warnLlmCallsPerTurn: z.number().int().nonnegative().optional(),
		warnPeakContextTokens: z.number().int().nonnegative().optional(),
		warnToolErrorsPerTurn: z.number().int().nonnegative().optional(),
		warnConsecutiveZeroOutputTurns: z.number().int().nonnegative().optional(),
	})
	.strict();

/**
 * The one username rule, shared by `id` and `linuxUser`: exactly what the
 * daemon's root-owned `magi-create-user` helper accepts (`^[a-z][a-z0-9-]{0,31}$`
 * in the worker Dockerfile). The schema used to admit `_`, so an id like
 * `data_bot` passed validation and then failed at OS-user creation on the
 * mission's first boot (LU1).
 */
export const LINUX_USERNAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Ids an authored config may not use: identities the platform itself speaks as. */
export const RESERVED_AGENT_IDS = new Set([
	"user",
	"system",
	"scheduler",
	"mission-copilot",
]);

export const MAX_AGENTS = 25;
export const MAX_SYSTEM_PROMPT_CHARS = 200_000;
export const MAX_MENTAL_MAP_CHARS = 500_000;

const AgentInputSchema = z.object({
	/**
	 * Also this agent's Linux OS username by default (linux-user.ts's
	 * resolveLinuxUsers(), when linuxUser below is omitted, which every
	 * shipped template now does) — reaches daemon.ts's ensureAgentUsers()
	 * and, from there, an `execFileSync` OS-user-creation call. Constrained
	 * to the same safe charset as linuxUser itself so a hostile id can never
	 * reach that call with anything an OS username / shell argument / file
	 * path segment couldn't already safely be (CR-02, 2026-08-09 audit).
	 */
	id: z
		.string()
		.trim()
		.regex(
			LINUX_USERNAME_RE,
			'must be a lowercase slug: a letter, then letters, digits or hyphens, at most 32 chars (e.g. "lead-analyst") — this id doubles as the agent\'s OS username',
		),
	/** Display name — optional on input, defaulted to id below (ADR-0021: the
	 * disk-YAML authoring format may omit it; every downstream consumer — the
	 * in-memory template cache, every `missions` document, every tool payload —
	 * always sees an explicit value, resolved exactly once, here). */
	name: z.string().trim().max(200).optional(),
	/** Free-text role label — same optional-on-input, defaulted-on-output rule as `name`. */
	role: z.string().trim().max(200).optional(),
	supervisor: z.string().trim().min(1).max(32),
	systemPrompt: z.string().trim().min(1).max(MAX_SYSTEM_PROMPT_CHARS),
	initialMentalMap: z.string().trim().min(1).max(MAX_MENTAL_MAP_CHARS),
	limits: LimitsSchema.optional(),
	/**
	 * The Linux OS user this agent runs as.
	 * In dev/test: set to a pool user provisioned by setup-dev.sh (e.g. "magi-w1").
	 * In production Docker: omit — the daemon derives the username from agent.id
	 * via ensureAgentUsers() at startup.
	 * When present, must satisfy LINUX_USERNAME_RE — the rule the OS-user helper
	 * enforces: a letter, then letters, digits or hyphens (max 32 chars).
	 */
	linuxUser: z
		.string()
		.trim()
		.regex(
			LINUX_USERNAME_RE,
			'must be a valid Linux username (e.g. "magi-w1"): a letter, then letters, digits or hyphens, at most 32 chars',
		)
		.optional(),
	active: z.boolean().optional(),
	disabledSkills: z.array(z.string()).optional(),
	disabledTools: z.array(z.string()).optional(),
});
// No catchall/passthrough: `name`/`role` were previously tolerated only via
// `.catchall(z.string())` even though every authored config sets them and
// several call sites (daemon.ts, orchestrator.ts, missions.ts) read them —
// they were real fields masquerading as informal extras. Promoted to the
// explicit shape above; unknown keys now silently strip (zod's plain
// z.object() default), the standard tolerant behavior with no downstream
// typing cost. A catchall/passthrough type also structurally conflicts
// with typed array fields like disabledTools — see git history if this
// needs revisiting.

/**
 * `name`/`role` become required in the *output* type via `.transform()` —
 * `z.infer` on a transformed schema reflects the transform's return shape, not
 * the input shape. This replaces the scattered `a.name ?? a.id`-style fallback
 * that used to live independently in daemon.ts/orchestrator.ts/missions.ts with
 * one place the default is decided (ADR-0021, "Required-field rule").
 */
export const AgentSchema = AgentInputSchema.transform((a) => ({
	...a,
	name: a.name ?? a.id,
	role: a.role ?? a.id,
}));

export const TeamConfigSchema = z.object({
	mission: z.object({
		id: z.string().trim().min(1),
		name: z.string().trim().min(1).max(200),
		/** Inner-loop LLM. Overrides the MODEL env var. Use "/" for OpenRouter (e.g. "anthropic/claude-sonnet-4-6"). */
		model: z.string().trim().min(1).optional(),
		/** Vision model for FetchUrl, InspectImage, BrowseWeb. Overrides VISION_MODEL env var. */
		visionModel: z.string().trim().min(1).optional(),
		/**
		 * IANA timezone (e.g. "America/New_York") used to add a local-time line to the
		 * current-time block every agent sees in its system prompt (prompt.ts). Optional —
		 * UTC/Unix/day-of-week are always shown regardless. Validated against the runtime's
		 * own IANA database so a typo fails config validation instead of silently omitting
		 * the local-time line.
		 */
		timezone: z
			.string()
			.trim()
			.min(1)
			.refine(
				(tz) => {
					try {
						new Intl.DateTimeFormat("en-US", { timeZone: tz });
						return true;
					} catch {
						return false;
					}
				},
				{
					message: "must be a valid IANA timezone name (e.g. America/New_York)",
				},
			)
			.optional(),
		/**
		 * Mission-wide hard spending cap in USD. Pauses the entire mission (all
		 * agent dispatch) when total spend reaches this value — distinct from any
		 * agent's own `limits.maxLifetimeCostUsd`, which only stops that one
		 * agent. Falls back to the MAX_COST_USD env var when unset (daemon.ts) —
		 * this field, when present, takes precedence, and is the only one of the
		 * two that survives a mission suspend/resume (the env var is re-derived
		 * fresh from the execution-plane machine's env at every boot).
		 */
		maxCostUsd: z.number().positive().optional(),
		/**
		 * Fly Machines guest memory in MB for this mission's execution-plane
		 * machine. Falls back to fly-machines.ts's 1024 MB default when unset.
		 * Capped at 4096 — this field is writable by the mission copilot's own
		 * SaveMissionConfig/save_session_config tools with no confirmation gate
		 * (same trust tier as SetMissionSpendCap, F-025), so the cap is defense
		 * in depth against an unconfirmed cost-increasing config change, not
		 * just a sanity bound. Takes effect on the next provision (fresh launch
		 * or resume), not on a running machine.
		 */
		memoryMb: z.number().int().positive().max(4096).optional(),
		/** Fly Machines guest CPU count. Same trust/effect caveats as memoryMb. */
		cpus: z.number().int().positive().max(4).optional(),
	}),
	agents: z.array(AgentSchema).min(1).max(MAX_AGENTS),
	/**
	 * Limits for the daemon-injected mission-copilot agent (see ADR-0016).
	 * A separate top-level field, not an entry in `agents[]`, because that
	 * array holds only authored team members — the copilot's identity is
	 * asserted in code (mission-copilot.ts), and parseTeamConfig rejects any
	 * authored agent claiming its reserved id. Same LimitsSchema shape and
	 * same "opt-in hard / defaulted soft" semantics as any other agent.
	 */
	missionCopilotLimits: LimitsSchema.optional(),
});

/**
 * Cross-field rules the per-field schema cannot express (LU1/RID1): agent
 * ids are unique, no two agents share an OS user, no agent takes a reserved
 * identity ("mission-copilot" is the daemon-injected copilot, ADR-0016 — but
 * not "copilot", which is the control-plane copilot's own bootstrap config),
 * and every supervisor is "user" or another agent of the team. Reported
 * with zod paths so the message names the offending agent.
 */
function refineTeam(
	cfg: z.infer<typeof TeamConfigSchema>,
	ctx: z.RefinementCtx,
): void {
	const ids = new Set<string>();
	const users = new Map<string, string>();
	cfg.agents.forEach((a, i) => {
		if (RESERVED_AGENT_IDS.has(a.id)) {
			ctx.addIssue({
				code: "custom",
				path: ["agents", i, "id"],
				message: `"${a.id}" is reserved for the platform (${[...RESERVED_AGENT_IDS].join(", ")}) and cannot be an agent id`,
			});
		}
		if (ids.has(a.id)) {
			ctx.addIssue({
				code: "custom",
				path: ["agents", i, "id"],
				message: `duplicate agent id "${a.id}"`,
			});
		}
		ids.add(a.id);
		const user = a.linuxUser ?? a.id;
		const other = users.get(user);
		if (other !== undefined && other !== a.id) {
			ctx.addIssue({
				code: "custom",
				path: ["agents", i, "linuxUser"],
				message: `agents "${other}" and "${a.id}" would share the OS user "${user}" — per-agent isolation requires one user each`,
			});
		}
		users.set(user, a.id);
	});
	cfg.agents.forEach((a, i) => {
		if (a.supervisor !== "user" && !ids.has(a.supervisor)) {
			ctx.addIssue({
				code: "custom",
				path: ["agents", i, "supervisor"],
				message: `supervisor "${a.supervisor}" is neither "user" nor an agent of this team`,
			});
		}
	});
}

const RefinedTeamConfigSchema = TeamConfigSchema.superRefine(refineTeam);

export type AgentConfig = z.infer<typeof AgentSchema>;
export type TeamConfig = z.infer<typeof TeamConfigSchema>;
export type Limits = z.infer<typeof LimitsSchema>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a plain object (already-structured — e.g. a MongoDB document's
 * `mission`/`agents`/`missionCopilotLimits` fields assembled into one object,
 * or an inline JSON payload from a tool call) into a validated TeamConfig.
 * Throws with a descriptive message on validation failure. This is the core
 * validator (ADR-0021, "Parsing") — Zod validation and the reserved-id check
 * happen here, on a plain object, no YAML involved. Every caller except
 * `parseTeamConfigYaml` below should call this directly.
 *
 * SECURITY (ENV1, 2026-10-15 audit): this function used to expand `${VAR}`
 * tokens in every string from `process.env` before validation. It is called
 * on tenant-supplied config (`POST /api/missions`) and agent/LLM-authored
 * tool payloads (`SaveMissionConfig`), not just operator-authored YAML, so
 * that expansion let any signed-in user retrieve any server environment
 * variable (CONTROL_API_KEY, MONGODB_URI, provider keys) back in the API
 * response or into an agent's own system prompt. Deleted outright rather
 * than gated behind an opt-in flag: no shipped template ever used it.
 */
export function parseTeamConfig(obj: unknown): TeamConfig {
	let parsed: TeamConfig;
	try {
		parsed = RefinedTeamConfigSchema.parse(obj);
	} catch (e) {
		if (e instanceof ZodError) {
			const issues = e.issues
				.map(
					(issue) => `  ${issue.path.map(String).join(".")}: ${issue.message}`,
				)
				.join("\n");
			throw new Error(`Team config validation failed:\n${issues}`);
		}
		throw e;
	}

	return parsed;
}

/**
 * Parse a team config YAML string into a validated TeamConfig. A thin wrapper
 * around `parseTeamConfig`, used in exactly two places in the whole system
 * (ADR-0021): the in-memory template loader (control-plane startup) and
 * `loadTeamConfig` below (local CLI/test-harness file loading). Never called
 * against anything stored in MongoDB — nothing there is YAML text anymore.
 */
export function parseTeamConfigYaml(yamlContent: string): TeamConfig {
	let raw: unknown;
	try {
		raw = parse(yamlContent);
	} catch (e) {
		throw new Error(`Team config YAML parse error: ${(e as Error).message}`);
	}
	return parseTeamConfig(raw);
}

/**
 * Load and parse a team config from a YAML file path.
 */
export function loadTeamConfig(filePath: string): TeamConfig {
	const content = readFileSync(filePath, "utf-8");
	return parseTeamConfigYaml(content);
}
