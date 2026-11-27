/**
 * Investigate (operation `agent.investigate`): one question about a codebase, put to a sub-agent
 * with a clean context. The sub-agent acts as the calling agent (its shell, its OS user, its
 * budget) but sees none of its history: only a skill, a briefing, the question and the answer's
 * JSON schema. The code it reads is a read-only reference copy kept by a platform task
 * (`/var/lib/magi/reference/<name>`), whose commit is returned with the answer.
 *
 * The answer must match the caller's schema: a mismatch gets one repair turn, then the call
 * fails. Nothing here decides whether the answer is right; the caller's pipeline does.
 *
 * The sub-agent has a turn and a time budget. When either runs out, its last step has no tools
 * and tells it to answer from what it has and say what it did not finish; the result is then
 * marked `incomplete`, with that explanation (turn.sub-agent-bounded, ADR-0039).
 */

import { PLATFORM_TASK_NAME_RE, PLATFORM_TASK_ROOT } from "@magi/agent-config";
import type { AssistantMessage, Message, Model } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { type CompleteFn, runInnerLoop, type WindDownReason } from "../loop.js";
import { loadPrompt } from "../prompts.js";
import { readInside } from "../safe-path.js";
import {
	type AclPolicy,
	createBashTool,
	type MagiTool,
	type ToolResult,
	truncate,
} from "../tools.js";
import { containResearchPaths } from "./research.js";
import type { SubAgentHooks } from "./sub-agent-hooks.js";

/** Model calls one investigation may make (its shell calls included) before it must answer. */
export const INVESTIGATE_DEFAULT_TURNS = 15;
export const INVESTIGATE_MAX_TURNS = 40;
/** Time one investigation may take before its last step. */
export const INVESTIGATE_TIME_BUDGET_MS = 5 * 60_000;
/** The Tool API's backstop: the budget, a tool call in flight, the last step and its repair. */
const INVESTIGATE_MAX_RUNTIME_MS = 10 * 60_000;
/** Longest explanation of what was not finished that is returned. */
const MAX_INCOMPLETE_NOTE = 1_000;
/** Caps on what the caller hands the sub-agent: the context stays small on purpose. */
const MAX_SKILL_BYTES = 40_000;
const MAX_BRIEFING_BYTES = 60_000;

const PARAMS = Type.Object({
	question: Type.String({
		description: "The one question to answer. Narrow and specific.",
	}),
	answer_schema: Type.Object(
		{},
		{
			additionalProperties: true,
			description:
				"JSON Schema the answer must match. The answer is returned as JSON.",
		},
	),
	skill_file: Type.Optional(
		Type.String({
			description:
				"A skill file whose instructions the sub-agent follows (what to look for, what counts as evidence). Within your permitted paths.",
		}),
	),
	briefing: Type.Optional(
		Type.String({
			description: "What the sub-agent starts with, besides the question.",
		}),
	),
	briefing_file: Type.Optional(
		Type.String({
			description:
				"A file whose content is the briefing. Within your permitted paths.",
		}),
	),
	reference: Type.Optional(
		Type.String({
			description: `The name of a reference copy under ${PLATFORM_TASK_ROOT} to investigate; its commit is returned with the answer.`,
		}),
	),
	max_turns: Type.Optional(
		Type.Integer({ minimum: 1, maximum: INVESTIGATE_MAX_TURNS }),
	),
});

type Args = {
	question: string;
	answer_schema: Record<string, unknown>;
	skill_file?: string;
	briefing?: string;
	briefing_file?: string;
	reference?: string;
	max_turns?: number;
};

export interface InvestigateOptions {
	/** The calling agent's working directory: the sub-agent's shell starts there. */
	workdir: string;
	/** Stores, meters and gates every step: by the caller's turn, or the job's Tool API call. */
	hooks: SubAgentHooks;
	/** Tests shorten the time budget. */
	timeBudgetMs?: number;
	/** Tests replace the model. */
	completeFn?: CompleteFn;
	/** Tests replace the shell. */
	shell?: MagiTool;
}

/** The last JSON value in a text: a ```json fence, else the text from its last `{` or `[`. */
export function extractJson(text: string): unknown {
	const blocks = fencedBlocks(text).filter(
		(b) => b.lang === "" || b.lang === "json",
	);
	const candidates = blocks.length
		? blocks.map((b) => b.body).reverse()
		: [text.trim(), ...lastBracketTails(text)];
	for (const c of candidates) {
		try {
			return JSON.parse(c.trim());
		} catch {
			// not this candidate; try the next
		}
	}
	return undefined;
}

/** Fenced blocks, paired line by line: a fence in another language must not shift the pairing. */
function fencedBlocks(text: string): { lang: string; body: string }[] {
	const blocks: { lang: string; body: string }[] = [];
	let open: { lang: string; lines: string[] } | null = null;
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (open === null) {
			if (t.startsWith("```"))
				open = { lang: t.slice(3).trim().toLowerCase(), lines: [] };
		} else if (t === "```") {
			blocks.push({ lang: open.lang, body: open.lines.join("\n") });
			open = null;
		} else open.lines.push(line);
	}
	return blocks;
}

function lastBracketTails(text: string): string[] {
	const out: string[] = [];
	for (const open of ["{", "["]) {
		const i = text.lastIndexOf(open === "{" ? "\n{" : "\n[");
		if (i >= 0) out.push(text.slice(i + 1));
		const j = text.indexOf(open);
		if (j >= 0) out.push(text.slice(j));
	}
	return out;
}

/** The provider's error when the last model call failed or was cut off: no answer to repair. */
function callFailure(messages: Message[]): string | undefined {
	const last = [...messages]
		.reverse()
		.find((m): m is AssistantMessage => m.role === "assistant");
	if (last?.stopReason !== "error" && last?.stopReason !== "aborted")
		return undefined;
	return `the model call failed (${last.stopReason}): ${(last.errorMessage ?? "no message").slice(0, 300)}`;
}

function finalText(messages: Message[]): string {
	const last = [...messages]
		.reverse()
		.find((m): m is AssistantMessage => m.role === "assistant");
	return (
		last?.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("")
			.trim() ?? ""
	);
}

/** What the sub-agent wrote before its JSON answer: its account of what it did not finish. */
export function textBeforeAnswer(text: string): string {
	const fence = text.lastIndexOf("```json");
	const brace = Math.max(text.lastIndexOf("\n{"), text.lastIndexOf("\n["));
	const cut = fence >= 0 ? fence : brace >= 0 ? brace : 0;
	return text.slice(0, cut).trim().slice(0, MAX_INCOMPLETE_NOTE);
}

function describeErrors(errors: ErrorObject[] | null | undefined): string {
	return (errors ?? [])
		.slice(0, 10)
		.map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`)
		.join("; ");
}

function err(text: string): ToolResult {
	return { content: [{ type: "text", text: truncate(text) }], isError: true };
}

/** The reference copy's status, read through the agent's own shell (agents may read it; the daemon may not). */
async function referenceStatus(
	shell: MagiTool,
	name: string,
	signal: AbortSignal | undefined,
): Promise<{ commit: string; path: string } | { error: string }> {
	if (!PLATFORM_TASK_NAME_RE.test(name))
		return { error: `reference "${name}" is not a valid name` };
	const dir = `${PLATFORM_TASK_ROOT}/${name}`;
	const r = await shell.execute(
		"investigate-ref",
		{ command: `cat ${dir}/status.json` },
		signal,
	);
	const text = r.content[0]?.type === "text" ? r.content[0].text : "";
	if (r.isError)
		return {
			error: `reference "${name}" has no status yet (${text.slice(0, 200)})`,
		};
	try {
		const commit = (JSON.parse(text) as { commit?: unknown }).commit;
		if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit))
			throw new Error("no commit");
		return { commit, path: `${dir}/current` };
	} catch {
		return { error: `reference "${name}" has an unreadable status.json` };
	}
}

interface Prepared {
	question: string;
	validate: ValidateFunction;
	skill: string;
	briefing: string;
	reference: { name: string; commit: string; path: string } | null;
}

/** Checks the arguments, reads the skill and briefing files, and the reference copy's commit. */
async function prepare(
	args: Args,
	acl: AclPolicy,
	ajv: Ajv,
	shell: MagiTool,
	signal: AbortSignal | undefined,
): Promise<Prepared | { error: string }> {
	const question = args.question?.trim();
	if (!question) return { error: "question is required" };
	let validate: ValidateFunction;
	try {
		validate = ajv.compile(args.answer_schema);
	} catch (e) {
		return {
			error: `answer_schema is not a valid JSON Schema: ${(e as Error).message}`,
		};
	}
	const files = [args.skill_file, args.briefing_file].filter((f): f is string =>
		Boolean(f),
	);
	const contained = containResearchPaths(acl.permittedPaths ?? [], files);
	if ("rejected" in contained)
		return { error: `path not within permitted paths: ${contained.rejected}` };
	const read = (path: string, max: number): string =>
		readInside(contained.rootOf.get(path) as string, path, {
			maxBytes: max,
		}).bytes.toString("utf8");
	let skill = "";
	let briefing = args.briefing ?? "";
	try {
		if (args.skill_file) skill = read(args.skill_file, MAX_SKILL_BYTES);
		if (args.briefing_file)
			briefing =
				`${briefing}\n\n${read(args.briefing_file, MAX_BRIEFING_BYTES)}`.trim();
	} catch (e) {
		return { error: `could not read a file: ${(e as Error).message}` };
	}
	let reference: Prepared["reference"] = null;
	if (args.reference) {
		const st = await referenceStatus(shell, args.reference, signal);
		if ("error" in st) return { error: st.error };
		reference = { name: args.reference, ...st };
	}
	return { question, validate, skill, briefing, reference };
}

/** The sub-agent's task: where the code is, the briefing, the question, and the answer's schema. */
function buildTask(p: Prepared, schema: Record<string, unknown>): string {
	const ref = p.reference;
	const gitDir = ref ? `${PLATFORM_TASK_ROOT}/${ref.name}/mirror.git` : "";
	return [
		ref
			? `## Code\n\nThe repository is at \`${ref.path}\` (commit ${ref.commit}). History: \`git -c safe.directory=${gitDir} --git-dir=${gitDir} log\`.`
			: "",
		p.briefing ? `## Briefing\n\n${p.briefing}` : "",
		`## Question\n\n${p.question}`,
		`## Answer\n\nEnd with one JSON value matching this schema, in a \`\`\`json fence:\n\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``,
	]
		.filter(Boolean)
		.join("\n\n");
}

type LoopCommon = Omit<
	Parameters<typeof runInnerLoop>[0],
	"task" | "tools" | "maxTurns" | "previousMessages"
>;

/** The investigation's outcome: an answer (marked when a budget ran out first) or why there is none. */
type Outcome =
	| {
			answer: unknown;
			turns: number;
			incomplete?: { reason: WindDownReason; note: string };
	  }
	| { error: string };

/** Runs the investigation, then at most one repair turn for an answer that misses the schema. */
async function investigate(
	common: LoopCommon,
	task: string,
	shell: MagiTool,
	budget: { maxTurns: number; timeBudgetMs: number },
	validate: ValidateFunction,
): Promise<Outcome> {
	const first = await runInnerLoop({
		...common,
		task,
		tools: [shell],
		maxTurns: budget.maxTurns,
		finalStep: {
			timeBudgetMs: budget.timeBudgetMs,
			notice: (reason) =>
				loadPrompt("investigate-final-step.md", {
					budget:
						reason === "turns"
							? `all ${budget.maxTurns} of your turns`
							: `your ${Math.round(budget.timeBudgetMs / 60_000)} minutes`,
				}),
		},
	});
	const failed = callFailure(first.messages);
	if (failed) return { error: failed };
	const text = finalText(first.messages);
	const incomplete = first.windDown
		? {
				reason: first.windDown,
				note: textBeforeAnswer(text) || "(no explanation given)",
			}
		: undefined;
	const done = (answer: unknown, turns: number): Outcome => ({
		answer,
		turns,
		...(incomplete ? { incomplete } : {}),
	});
	let answer = extractJson(text);
	if (answer !== undefined && validate(answer))
		return done(answer, first.turnCount);
	const why =
		answer === undefined
			? "no JSON value was found"
			: describeErrors(validate.errors);
	const repair = await runInnerLoop({
		...common,
		previousMessages: first.messages,
		task: `Your answer does not match the schema (${why}). Reply with only the corrected JSON value, in a \`\`\`json fence.`,
		tools: [],
		maxTurns: 1,
	});
	const repairFailed = callFailure(repair.messages);
	if (repairFailed) return { error: repairFailed };
	answer = extractJson(finalText(repair.messages));
	if (answer !== undefined && validate(answer))
		return done(answer, first.turnCount + repair.turnCount);
	return {
		error: `the answer did not match the schema after one repair (${answer === undefined ? "no JSON value" : describeErrors(validate.errors)}). Narrow the question or simplify the schema.`,
	};
}

export function createInvestigateTool(
	model: Model<string>,
	acl: AclPolicy,
	opts: InvestigateOptions,
): MagiTool {
	// First error only: collecting every error of a large hostile value can exhaust memory.
	const ajv = new Ajv({ strict: false });
	const shell = opts.shell ?? createBashTool(opts.workdir, acl);

	return {
		name: "Investigate",
		operation: "agent.investigate",
		description:
			"Put one narrow question about a codebase to a sub-agent with a clean context: it has your shell and permissions but none of your history, follows the skill file you give it, and must answer as JSON matching your schema. " +
			`Give it a reference copy (a folder under ${PLATFORM_TASK_ROOT}) to read; the copy's commit is returned with the answer. ` +
			"Use it for each item of a review rather than investigating many things in your own context. " +
			`It has ${INVESTIGATE_TIME_BUDGET_MS / 60_000} minutes and its turns; when either runs out it answers from what it has, and the result carries \`incomplete\` with what it did not finish and why.`,
		parameters: PARAMS,
		maxRuntimeMs: () => INVESTIGATE_MAX_RUNTIME_MS,

		async execute(id, rawArgs, signal) {
			const args = rawArgs as Args;
			const p = await prepare(args, acl, ajv, shell, signal);
			if ("error" in p) return err(`Investigate: ${p.error}`);
			const systemPrompt = loadPrompt("investigate.md", {
				skill: p.skill ? `## Skill\n\n${p.skill}` : "",
			});
			const { hooks } = opts;
			const outcome = await investigate(
				{
					model,
					getSystemPrompt: () => systemPrompt,
					signal,
					onMessage: async (msg: Message) => hooks.onMessage(id, msg),
					onLlmCall: hooks.onLlmCall,
					beforeLlmCall: hooks.beforeLlmCall,
					completeFn: opts.completeFn,
				},
				buildTask(p, args.answer_schema),
				shell,
				{
					maxTurns: args.max_turns ?? INVESTIGATE_DEFAULT_TURNS,
					timeBudgetMs: opts.timeBudgetMs ?? INVESTIGATE_TIME_BUDGET_MS,
				},
				p.validate,
			);
			if ("error" in outcome) return err(`Investigate: ${outcome.error}`);
			const ref = p.reference;
			const result = {
				answer: outcome.answer,
				reference: ref ? { name: ref.name, commit: ref.commit } : null,
				turns: outcome.turns,
				...(outcome.incomplete ? { incomplete: outcome.incomplete } : {}),
			};
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		},
	};
}
