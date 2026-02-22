import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
 * Three tools cover all practical needs:
 *   - Bash    — read files (cat), list dirs (ls), search (grep/rg), run scripts, etc.
 *   - WriteFile — create or overwrite a file (Bash heredocs are awkward with arbitrary content)
 *   - EditFile  — safe find-and-replace within a file (avoids sed quoting pitfalls)
 */
export function createFileTools(cwd: string): MagiTool[] {
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
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, args.content as string, "utf-8");
				return ok(
					`Wrote ${(args.content as string).length} bytes to ${target}`,
				);
			} catch (e) {
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
				return err(`EditFile: ${(e as Error).message}`);
			}
		},
	};

	return [bash, writeFile, editFile];
}
