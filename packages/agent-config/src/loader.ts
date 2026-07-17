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
const LimitsSchema = z
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

const AgentSchema = z.object({
	id: z.string().trim().min(1),
	/** Display name — falls back to id where omitted (dashboard, step-mode prompts). */
	name: z.string().trim().optional(),
	/** Free-text role label — falls back to id where omitted (MonitorServer's AgentInfo). */
	role: z.string().trim().optional(),
	supervisor: z.string().trim().min(1),
	systemPrompt: z.string().trim().min(1),
	initialMentalMap: z.string().trim().min(1),
	limits: LimitsSchema.optional(),
	/**
	 * The Linux OS user this agent runs as.
	 * In dev/test: set to a pool user provisioned by setup-dev.sh (e.g. "magi-w1").
	 * In production Docker: omit — the daemon derives the username from agent.id
	 * via ensureAgentUsers() at startup.
	 * When present, must follow Linux username conventions: starts with a letter
	 * or underscore, followed by letters, digits, hyphens, or underscores (max 32 chars).
	 */
	linuxUser: z
		.string()
		.trim()
		.regex(
			/^[a-z_][a-z0-9_-]{0,31}$/,
			'must be a valid Linux username (e.g. "magi-w1")',
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

const TeamConfigSchema = z.object({
	mission: z.object({
		id: z.string().trim().min(1),
		name: z.string().trim().min(1),
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
	}),
	agents: z.array(AgentSchema).min(1),
});

export type AgentConfig = z.infer<typeof AgentSchema>;
export type TeamConfig = z.infer<typeof TeamConfigSchema>;

// ---------------------------------------------------------------------------
// Environment variable expansion
// ---------------------------------------------------------------------------

/**
 * Expand ${VAR} tokens in all string values of the parsed YAML object.
 * Throws if a referenced variable is not set in process.env.
 * Applied before Zod validation so schema errors reference the expanded values.
 */
function expandEnvInObject(obj: unknown): unknown {
	if (typeof obj === "string") {
		return obj.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
			const val = process.env[name];
			if (val === undefined) {
				throw new Error(
					`Team config references undefined environment variable: \${${name}}`,
				);
			}
			return val;
		});
	}
	if (Array.isArray(obj)) return obj.map(expandEnvInObject);
	if (obj !== null && typeof obj === "object") {
		return Object.fromEntries(
			Object.entries(obj as Record<string, unknown>).map(([k, v]) => [
				k,
				expandEnvInObject(v),
			]),
		);
	}
	return obj;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a team config YAML string into a validated TeamConfig.
 * Throws with a descriptive message on validation failure.
 * Environment variables (${VAR}) in string fields are expanded before validation.
 */
export function parseTeamConfig(yamlContent: string): TeamConfig {
	let raw: unknown;
	try {
		raw = parse(yamlContent);
	} catch (e) {
		throw new Error(`Team config YAML parse error: ${(e as Error).message}`);
	}

	raw = expandEnvInObject(raw);

	let parsed: TeamConfig;
	try {
		parsed = TeamConfigSchema.parse(raw);
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

	// "mission-copilot" is reserved for the daemon-injected mission copilot
	// agent (see ADR-0016) — it is never parsed from authored mission YAML.
	// This is defense in depth for the structural guarantee that elevated
	// tools are granted only to that literal agent id: rejecting it here means
	// an authored team config can never collide with or spoof that identity.
	// (Not "copilot" — that id belongs to the control-plane copilot's own
	// bootstrap config, config/teams/copilot.yaml, an unrelated identity this
	// check has no reason to touch.)
	if (parsed.agents.some((a) => a.id === "mission-copilot")) {
		throw new Error(
			'Team config validation failed:\n  agents: id "mission-copilot" is reserved for the mission copilot (daemon-injected, see ADR-0016) and cannot be used in authored team config',
		);
	}

	return parsed;
}

/**
 * Load and parse a team config from a YAML file path.
 */
export function loadTeamConfig(filePath: string): TeamConfig {
	const content = readFileSync(filePath, "utf-8");
	return parseTeamConfig(content);
}
