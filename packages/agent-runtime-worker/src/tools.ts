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
	/** Agent identity — always set; used for PolicyViolationError attribution. */
	agentId: string;
	/**
	 * Execution timeout in milliseconds, computed by the orchestrator.
	 * For Bash: passed to spawnSync as the process timeout.
	 * For WriteFile/EditFile: bounds the overall child process lifetime via execa.
	 * Always required — no silent fallback in the child.
	 */
	timeoutMs: number;
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
		public readonly agentId: string,
	) {
		super(
			`PolicyViolationError: "${action}" denied on "${path}" for agent "${agentId}"`,
		);
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
	 * The Linux OS user these tools execute as.
	 *
	 * Every shell tool call (Bash / WriteFile / EditFile) is executed in a
	 * clean child process running as this OS user via `sudo -u <linuxUser>`.
	 * The child receives no secrets in its environment.
	 *
	 * Must be a pool user provisioned by setup-dev.sh (e.g. "magi-w1").
	 * Required — absence is a type error.
	 */
	linuxUser: string;
}

function isPermitted(target: string, permittedPaths: string[]): boolean {
	// Normalize both sides with resolve() so that paths containing ".." or
	// redundant separators cannot bypass the check (e.g. workdir/../other-agent).
	const normalizedTarget = resolve(target);
	return permittedPaths.some((p) => {
		const normalizedP = resolve(p);
		return (
			normalizedTarget === normalizedP ||
			normalizedTarget.startsWith(normalizedP + sep)
		);
	});
}

function checkPath(
	target: string,
	action: string,
	permittedPaths: string[],
	agentId: string,
): void {
	if (!isPermitted(target, permittedPaths)) {
		throw new PolicyViolationError(target, action, agentId);
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
	return { content: [{ type: "text", text: truncate(text) }], isError: true };
}

// ---------------------------------------------------------------------------
// Pure exec functions — no side effects beyond file I/O.
// Called from tool-executor.ts (isolated child process).
// ---------------------------------------------------------------------------

export function execBash(
	command: string,
	cwd: string,
	timeoutMs: number,
): ToolResult {
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
			return err(output || `Exited with code ${result.status}`);
		}
		return ok(output || "(no output)");
	} catch (e) {
		return err(`Bash: ${(e as Error).message}`);
	}
}

export function execWriteFile(
	path: string,
	content: string,
	cwd: string,
	permittedPaths: string[],
	agentId: string,
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
	agentId: string,
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
// Isolated tool dispatch — always forks a clean child process as the agent's
// OS user. There is no in-process fallback: running shell tools in the
// orchestrator process would expose ANTHROPIC_API_KEY and other secrets to
// the LLM via printenv / /proc/self/environ.
// ---------------------------------------------------------------------------

/** Maximum Bash timeout the LLM may request (10 minutes). */
const MAX_BASH_TIMEOUT_MS = 600_000;

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
	// Resolve path to the compiled tool-executor.js.
	// import.meta.url points to dist/tools.js when compiled, but to src/tools.ts
	// when running under vitest (which executes TypeScript directly). In both
	// cases the compiled child entry point lives at dist/tool-executor.js.
	const __file = fileURLToPath(import.meta.url);
	const toolExecutor = __file.endsWith(".ts")
		? join(dirname(__file), "..", "dist", "tool-executor.js")
		: join(dirname(__file), "tool-executor.js");
	const nodeExe = process.execPath;
	const { timeoutMs } = request;

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
// Isolation startup check
// ---------------------------------------------------------------------------

/**
 * Startup invariant: verify that child processes cannot see orchestrator
 * secrets (ANTHROPIC_API_KEY, etc.).
 *
 * Forks a real child via the same runIsolatedToolCall path used at runtime
 * and checks that ANTHROPIC_API_KEY is absent from the child environment.
 *
 * Throws if:
 *   - sudo is misconfigured (pool user doesn't exist, sudoers missing)
 *   - ANTHROPIC_API_KEY is visible in the child environment
 *
 * Call once per mission after workspaceManager.provision().
 */
export async function verifyIsolation(
	linuxUser: string,
	workdir: string,
): Promise<void> {
	const result = await runIsolatedToolCall(linuxUser, {
		tool: "Bash",
		// Outputs "LEAKED" if ANTHROPIC_API_KEY is set in the child env, empty otherwise.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash ${var:+value} syntax, not a JS template
		args: { command: 'echo "${ANTHROPIC_API_KEY:+LEAKED}"' },
		workdir,
		permittedPaths: [workdir],
		agentId: "_isolation-check",
		timeoutMs: 10_000,
	});

	if (result.isError) {
		throw new Error(
			`Isolation check failed — sudo or pool user "${linuxUser}" may not be configured.\n` +
				`${result.content[0].text}\n` +
				`Run scripts/setup-dev.sh to create pool users and configure sudoers.`,
		);
	}

	const output = result.content[0].text.trim();
	if (output === "LEAKED") {
		throw new Error(
			`CRITICAL: secret containment broken — ANTHROPIC_API_KEY is visible in the ` +
				`child process environment running as "${linuxUser}". ` +
				`Shell tools are not safe to run until this is fixed.`,
		);
	}
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create the standard set of agent shell tools rooted at `cwd`.
 *
 * `acl` is required — every tool invocation must carry an explicit security
 * context. There is no default or fallback.
 *
 * Every shell tool call (Bash / WriteFile / EditFile) is executed in a clean
 * child process running as `acl.linuxUser` via `sudo -u <linuxUser>`. The
 * child receives no secrets in its environment. There is no in-process
 * fallback: running shell tools in the orchestrator process would expose
 * secrets to the LLM.
 *
 * Integration tests must use a real pool user (e.g. "magi-w1") provisioned
 * by setup-dev.sh. Tests that use `linuxUser: ${USER}` or similar are no
 * longer valid — update them to use pool users.
 */
export function createFileTools(cwd: string, acl: AclPolicy): MagiTool[] {
	const { agentId, permittedPaths, linuxUser } = acl;

	// ── Bash ──────────────────────────────────────────────────────────────────

	const bash: MagiTool = {
		name: "Bash",
		description:
			"Execute a bash command in the agent working directory. Returns combined stdout and stderr. " +
			"Use for reading files (cat), listing dirs (ls), searching (grep/rg), running tests, compiling, etc.",
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(
				Type.Number({
					description: "Timeout in seconds (default: 30, max: 600)",
				}),
			),
		}),
		async execute(_id, args, signal) {
			const timeoutMs = Math.min(
				((args.timeout as number) ?? 30) * 1_000,
				MAX_BASH_TIMEOUT_MS,
			);
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
			return runIsolatedToolCall(
				linuxUser,
				{
					tool: "WriteFile",
					args,
					workdir: cwd,
					permittedPaths,
					agentId,
					timeoutMs: 30_000,
				},
				signal,
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
			return runIsolatedToolCall(
				linuxUser,
				{
					tool: "EditFile",
					args,
					workdir: cwd,
					permittedPaths,
					agentId,
					timeoutMs: 30_000,
				},
				signal,
			);
		},
	};

	return [bash, writeFile, editFile];
}
