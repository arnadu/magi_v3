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

const AgentInputSchema = z.object({
	id: z.string().trim().min(1),
	/** Display name — optional on input, defaulted to id below (ADR-0021: the
	 * disk-YAML authoring format may omit it; every downstream consumer — the
	 * in-memory template cache, every `missions` document, every tool payload —
	 * always sees an explicit value, resolved exactly once, here). */
	name: z.string().trim().optional(),
	/** Free-text role label — same optional-on-input, defaulted-on-output rule as `name`. */
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
	}),
	agents: z.array(AgentSchema).min(1),
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

export type AgentConfig = z.infer<typeof AgentSchema>;
export type TeamConfig = z.infer<typeof TeamConfigSchema>;
export type Limits = z.infer<typeof LimitsSchema>;

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
 * Parse a plain object (already-structured — e.g. a MongoDB document's
 * `mission`/`agents`/`missionCopilotLimits` fields assembled into one object,
 * or an inline JSON payload from a tool call) into a validated TeamConfig.
 * Throws with a descriptive message on validation failure. This is the core
 * validator (ADR-0021, "Parsing") — env-var expansion, Zod validation, and the
 * reserved-id check all happen here, on a plain object, no YAML involved.
 * Every caller except `parseTeamConfigYaml` below should call this directly.
 */
export function parseTeamConfig(obj: unknown): TeamConfig {
	const raw = expandEnvInObject(obj);

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
