import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { ZodError, z } from "zod";

// ---------------------------------------------------------------------------
// Schemas — single source of truth for both validation and TypeScript types
// ---------------------------------------------------------------------------

const AgentSchema = z
	.object({
		id: z.string().trim().min(1),
		supervisor: z.string().trim().min(1),
		systemPrompt: z.string().trim().min(1),
		initialMentalMap: z.string().trim().min(1),
		/**
		 * The Linux OS user this agent runs as.
		 * Must be a pool user provisioned by setup-dev.sh (e.g. "magi-w1").
		 * Tool execution always runs as this user via `sudo -u <linuxUser>`.
		 * Required — omitting this field is a validation error.
		 * Must follow Linux username conventions: starts with a letter or underscore,
		 * followed by letters, digits, hyphens, or underscores (max 32 chars total).
		 */
		linuxUser: z
			.string()
			.trim()
			.regex(
				/^[a-z_][a-z0-9_-]{0,31}$/,
				'must be a valid Linux username (e.g. "magi-w1")',
			),
	})
	.catchall(z.string().trim());

const TeamConfigSchema = z.object({
	mission: z.object({
		id: z.string().trim().min(1),
		name: z.string().trim().min(1),
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

	try {
		return TeamConfigSchema.parse(raw);
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
}

/**
 * Load and parse a team config from a YAML file path.
 */
export function loadTeamConfig(filePath: string): TeamConfig {
	const content = readFileSync(filePath, "utf-8");
	return parseTeamConfig(content);
}
