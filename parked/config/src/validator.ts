import { parse as parseYaml } from "yaml";
import { TeamConfigSchema } from "./schema.js";
import type { TeamConfig } from "./schema.js";

export interface ValidationError {
  /** Dot-separated field path, e.g. "agents.0.tools.outerLoop". Empty for YAML parse errors. */
  path: string;
  message: string;
}

export type ValidationResult =
  | { success: true; config: TeamConfig }
  | { success: false; errors: ValidationError[] };

/**
 * Parse and validate a team config YAML string.
 *
 * Returns a typed TeamConfig on success, or a structured error list on failure.
 * Never throws.
 */
export function validateTeamConfig(yamlContent: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlContent);
  } catch (e) {
    return {
      success: false,
      errors: [
        { path: "", message: `YAML parse error: ${(e as Error).message}` },
      ],
    };
  }

  const result = TeamConfigSchema.safeParse(parsed);

  if (result.success) {
    return { success: true, config: result.data };
  }

  return {
    success: false,
    errors: result.error.errors.map((err) => ({
      path: err.path.join("."),
      message: err.message,
    })),
  };
}
