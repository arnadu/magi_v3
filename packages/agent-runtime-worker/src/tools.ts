import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type TSchema, Type } from "@sinclair/typebox";
import { execa } from "execa";

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
// IPC types (orchestrator ↔ tool-executor child process)
// ---------------------------------------------------------------------------

export interface ToolRequest {
	tool: "Bash" | "WriteFile" | "EditFile";
	args: Record<string, unknown>;
	workdir: string;
	permittedPaths: string[];
	agentId?: string;
	/** Timeout for the tool itself in milliseconds. */
	timeoutMs?: number;
}

export interface ToolResponse {
	ok: boolean;
	text: string;
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
	/**
	 * When set, Bash/WriteFile/EditFile execute in a clean child process as
	 * this Linux OS user via `sudo`. The child receives no secrets in its
	 * environment. Only set this when the OS user is guaranteed to exist
	 * (production pool users provisioned by setup-dev.sh).
	 */
	linuxUser?: string;
}

function isPermitted(target: string, permittedPaths: string[]): boolean {
	return permittedPaths.some(
		(p) =>
			target === p || target.startsWith(p + sep) || target.startsWith(`${p}/`),
	);
}

function checkPath(
	target: string,
	action: string,
	permittedPaths: string[],
	agentId?: string,
): void {
	if (!isPermitted(target, permittedPaths)) {
		throw new PolicyViolationError(target, action, agentId);
	}
}

/**
 * Extract absolute path tokens from a bash command string and check each
 * against the ACL policy. Soft enforcement: catches explicit absolute path
 * references to workspace paths but not dynamically constructed paths.
 */
function checkBashPaths(
	command: string,
	permittedPaths: string[],
	agentId?: string,
): void {
	const tokens = command.match(/\/[^\s"'<>|&;(){}$\\]+/g) ?? [];
	for (const raw of tokens) {
		// Only check paths that look like agent workspace paths.
		if (!/\/missions\/|\/home\/magi-/.test(raw)) continue;
		const token = raw.replace(/[,;)'"]+$/, ""); // strip trailing punctuation
		if (!isPermitted(token, permittedPaths)) {
			throw new PolicyViolationError(token, "bash", agentId);
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
// Pure exec functions — no side effects beyond file I/O.
// Called in-process (tests / no pool user) or from tool-executor.ts (isolated).
// ---------------------------------------------------------------------------

export function execBash(
	command: string,
	cwd: string,
	timeoutMs: number,
	permittedPaths: string[],
	agentId?: string,
): ToolResult {
	try {
		checkBashPaths(command, permittedPaths, agentId);
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
}

export function execWriteFile(
	path: string,
	content: string,
	cwd: string,
	permittedPaths: string[],
	agentId?: string,
): ToolResult {
	try {
		const target = resolve(cwd, path);
		checkPath(target, "write", permittedPaths, agentId);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content, "utf-8");
		return ok(`Wrote ${content.length} bytes to ${target}`);
	} catch (e) {
		if (e instanceof PolicyViolationError) return err(e.message);
		return err(`WriteFile: ${(e as Error).message}`);
	}
}

export function execEditFile(
	path: string,
	oldStr: string,
	newStr: string,
	replaceAll: boolean,
	cwd: string,
	permittedPaths: string[],
	agentId?: string,
): ToolResult {
	try {
		const target = resolve(cwd, path);
		checkPath(target, "edit", permittedPaths, agentId);
		const content = readFileSync(target, "utf-8");
		if (!content.includes(oldStr)) {
			return err(`EditFile: old_string not found in ${target}`);
		}
		const count = replaceAll ? content.split(oldStr).length - 1 : 1;
		const updated = replaceAll
			? content.split(oldStr).join(newStr)
			: content.replace(oldStr, newStr);
		writeFileSync(target, updated, "utf-8");
		return ok(`Replaced ${count} occurrence(s) in ${target}`);
	} catch (e) {
		if (e instanceof PolicyViolationError) return err(e.message);
		return err(`EditFile: ${(e as Error).message}`);
	}
}

// ---------------------------------------------------------------------------
// Isolated tool dispatch — forks a clean child process as the agent's OS user
// ---------------------------------------------------------------------------

/**
 * Run a tool in a clean child process as `linuxUser` via sudo.
 * The child receives no secrets: only PATH and HOME are passed in env.
 * stdout carries the ToolResponse JSON; stderr is inherited for logging.
 */
async function runIsolatedToolCall(
	linuxUser: string,
	request: ToolRequest,
	signal?: AbortSignal,
): Promise<ToolResult> {
	const toolExecutor = join(
		dirname(fileURLToPath(import.meta.url)),
		"tool-executor.js",
	);
	const nodeExe = process.execPath;
	const timeoutMs = request.timeoutMs ?? 120_000;

	try {
		const { stdout } = await execa(
			"sudo",
			["-u", linuxUser, nodeExe, toolExecutor],
			{
				input: JSON.stringify(request),
				env: {
					PATH: process.env.PATH ?? "",
					HOME: `/home/${linuxUser}`,
				},
				cancelSignal: signal,
				// Give the child 5 s beyond the tool timeout to flush and exit cleanly.
				timeout: timeoutMs + 5_000,
				forceKillAfterDelay: 3_000,
			},
		);
		const resp: ToolResponse = JSON.parse(stdout);
		return { content: [{ type: "text", text: resp.text }], isError: !resp.ok };
	} catch (e) {
		return err(`Isolated tool call failed: ${(e as Error).message}`);
	}
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create the standard set of agent shell tools rooted at `cwd`.
 *
 * When `acl.linuxUser` is set, every shell tool call (Bash / WriteFile /
 * EditFile) is executed in a clean child process running as that OS user via
 * `sudo`. The child has no secrets in its environment. Use this in production
 * where pool users (magi-w1 … magi-w6) are provisioned by setup-dev.sh.
 *
 * When `acl.linuxUser` is absent, tools run in-process as the current user.
 * This is appropriate for integration tests and local dev without pool users.
 *
 * In both modes the software ACL (permittedPaths) is enforced.
 */
export function createFileTools(cwd: string, acl?: AclPolicy): MagiTool[] {
	const { agentId, permittedPaths, linuxUser } = acl ?? {
		agentId: "",
		permittedPaths: [],
	};

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
		async execute(_id, args, signal) {
			const command = args.command as string;
			const timeoutMs = ((args.timeout as number) ?? 30) * 1_000;

			if (linuxUser) {
				return runIsolatedToolCall(
					linuxUser,
					{
						tool: "Bash",
						args,
						workdir: cwd,
						permittedPaths,
						agentId,
						timeoutMs,
					},
					signal,
				);
			}
			return execBash(command, cwd, timeoutMs, permittedPaths, agentId);
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
		async execute(_id, args, signal) {
			if (linuxUser) {
				return runIsolatedToolCall(
					linuxUser,
					{
						tool: "WriteFile",
						args,
						workdir: cwd,
						permittedPaths,
						agentId,
					},
					signal,
				);
			}
			return execWriteFile(
				args.path as string,
				args.content as string,
				cwd,
				permittedPaths,
				agentId,
			);
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
		async execute(_id, args, signal) {
			if (linuxUser) {
				return runIsolatedToolCall(
					linuxUser,
					{
						tool: "EditFile",
						args,
						workdir: cwd,
						permittedPaths,
						agentId,
					},
					signal,
				);
			}
			return execEditFile(
				args.path as string,
				args.old_string as string,
				args.new_string as string,
				args.replace_all === true,
				cwd,
				permittedPaths,
				agentId,
			);
		},
	};

	return [bash, writeFile, editFile];
}
