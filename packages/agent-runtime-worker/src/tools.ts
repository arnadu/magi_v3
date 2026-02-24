import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { type TSchema, Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

export interface MagiTool {
	name: string;
	description: string;
	/** TypeBox TSchema — passed to pi-ai as the tool's parameter schema. */
	parameters: TSchema;
	execute(
		toolCallId: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// ACL enforcement
// ---------------------------------------------------------------------------

/**
 * Thrown (then caught and returned as an error ToolResult) when an agent
 * attempts to access a path outside its permitted set.
 * Distinct from OS errors so callers can detect it by name.
 */
export class PolicyViolationError extends Error {
	constructor(
		public readonly path: string,
		public readonly action: string,
		public readonly agentId?: string,
	) {
		const who = agentId ? ` for agent "${agentId}"` : "";
		super(`PolicyViolationError: "${action}" denied on "${path}"${who}`);
		this.name = "PolicyViolationError";
	}
}

/**
 * When provided to createFileTools, path operations are checked against
 * permittedPaths before execution.
 */
export interface AclPolicy {
	agentId: string;
	/**
	 * Absolute paths the agent may access. Any path not under one of these
	 * is denied with PolicyViolationError.
	 */
	permittedPaths: string[];
}

function isPermitted(target: string, permittedPaths: string[]): boolean {
	return permittedPaths.some(
		(p) =>
			target === p || target.startsWith(p + sep) || target.startsWith(`${p}/`),
	);
}

function checkPath(target: string, action: string, policy: AclPolicy): void {
	if (!isPermitted(target, policy.permittedPaths)) {
		throw new PolicyViolationError(target, action, policy.agentId);
	}
}

/**
 * Extract absolute path tokens from a bash command string and check each
 * against the ACL policy. Soft enforcement: catches explicit absolute path
 * references to workspace paths but not dynamically constructed paths.
 */
function checkBashPaths(command: string, policy: AclPolicy): void {
	const tokens = command.match(/\/[^\s"'<>|&;(){}$\\]+/g) ?? [];
	for (const raw of tokens) {
		// Only check paths that look like agent workspace paths.
		if (!/\/missions\/|\/home\/magi-/.test(raw)) continue;
		const token = raw.replace(/[,;)'"]+$/, ""); // strip trailing punctuation
		if (!isPermitted(token, policy.permittedPaths)) {
			throw new PolicyViolationError(token, "bash", policy.agentId);
		}
	}
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const MAX_LINES = 500;
const MAX_CHARS = 20_000;

function truncate(text: string): string {
	const lines = text.split("\n");
	if (lines.length > MAX_LINES) {
		return (
			lines.slice(0, MAX_LINES).join("\n") +
			`\n[Output truncated: ${lines.length} lines total, showing first ${MAX_LINES}]`
		);
	}
	if (text.length > MAX_CHARS) {
		return `${text.slice(0, MAX_CHARS)}\n[Output truncated at ${MAX_CHARS} chars]`;
	}
	return text;
}

function ok(text: string): ToolResult {
	return { content: [{ type: "text", text: truncate(text) }] };
}

function err(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create the standard set of agent tools rooted at `cwd`.
 * All relative paths supplied by the agent are resolved against `cwd`.
 *
 * When `acl` is provided, every path operation is checked against the
 * agent's permitted paths before execution. Violations are returned as
 * error ToolResults containing "PolicyViolationError".
 *
 * Three tools cover all practical needs:
 *   - Bash      — read files (cat), list dirs (ls), search (grep/rg), run scripts, etc.
 *   - WriteFile — create or overwrite a file
 *   - EditFile  — safe find-and-replace within a file
 */
export function createFileTools(cwd: string, acl?: AclPolicy): MagiTool[] {
	function res(p: string): string {
		return resolve(cwd, p);
	}

	// ── Bash ──────────────────────────────────────────────────────────────────

	const bash: MagiTool = {
		name: "Bash",
		description:
			"Execute a bash command in the agent working directory. Returns combined stdout and stderr. " +
			"Use for reading files (cat), listing dirs (ls), searching (grep/rg), running tests, compiling, etc.",
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in seconds (default: 30)" }),
			),
		}),
		async execute(_id, args) {
			const command = args.command as string;
			const timeoutMs = ((args.timeout as number) ?? 30) * 1_000;
			try {
				if (acl) checkBashPaths(command, acl);
				const result = spawnSync("bash", ["-c", command], {
					cwd,
					encoding: "utf-8",
					timeout: timeoutMs,
					maxBuffer: 10 * 1024 * 1024,
				});
				const output = [result.stdout, result.stderr].filter(Boolean).join("");
				if (result.signal) {
					return err(`Bash: killed by signal ${result.signal}`);
				}
				if (result.status !== 0 && result.status !== null) {
					return err(truncate(output || `Exited with code ${result.status}`));
				}
				return ok(truncate(output || "(no output)"));
			} catch (e) {
				if (e instanceof PolicyViolationError) return err(e.message);
				return err(`Bash: ${(e as Error).message}`);
			}
		},
	};

	// ── WriteFile ─────────────────────────────────────────────────────────────

	const writeFile: MagiTool = {
		name: "WriteFile",
		description:
			"Write content to a file, creating parent directories if needed. Overwrites existing content.",
		parameters: Type.Object({
			path: Type.String({ description: "Path to write to" }),
			content: Type.String({ description: "Content to write" }),
		}),
		async execute(_id, args) {
			try {
				const target = res(args.path as string);
				if (acl) checkPath(target, "write", acl);
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, args.content as string, "utf-8");
				return ok(
					`Wrote ${(args.content as string).length} bytes to ${target}`,
				);
			} catch (e) {
				if (e instanceof PolicyViolationError) return err(e.message);
				return err(`WriteFile: ${(e as Error).message}`);
			}
		},
	};

	// ── EditFile ──────────────────────────────────────────────────────────────

	const editFile: MagiTool = {
		name: "EditFile",
		description:
			"Replace the first occurrence of old_string with new_string in a file. " +
			"Set replace_all to true to replace every occurrence.",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file" }),
			old_string: Type.String({ description: "Exact text to find" }),
			new_string: Type.String({ description: "Replacement text" }),
			replace_all: Type.Optional(
				Type.Boolean({
					description: "Replace all occurrences (default: false)",
				}),
			),
		}),
		async execute(_id, args) {
			try {
				const target = res(args.path as string);
				if (acl) checkPath(target, "edit", acl);
				const content = readFileSync(target, "utf-8");
				const oldStr = args.old_string as string;
				const newStr = args.new_string as string;
				if (!content.includes(oldStr)) {
					return err(`EditFile: old_string not found in ${target}`);
				}
				const count =
					args.replace_all === true ? content.split(oldStr).length - 1 : 1;
				const updated =
					args.replace_all === true
						? content.split(oldStr).join(newStr)
						: content.replace(oldStr, newStr);
				writeFileSync(target, updated, "utf-8");
				return ok(`Replaced ${count} occurrence(s) in ${target}`);
			} catch (e) {
				if (e instanceof PolicyViolationError) return err(e.message);
				return err(`EditFile: ${(e as Error).message}`);
			}
		},
	};

	return [bash, writeFile, editFile];
}
