/**
 * Research — an agentic tool that delegates web research to a nested inner loop.
 *
 * The main agent calls Research(question) and receives a concise finding (200–500 words
 * + source URLs). All intermediate SearchWeb / FetchUrl / Bash calls happen inside an
 * isolated sub-loop whose messages never enter the main agent's context.
 *
 * Findings are persisted to sharedDir/research/ so teammates can benefit from prior
 * research without re-running the same queries.
 *
 * See ADR-0010 for design rationale.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { AssistantMessage, Message, Model } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { LlmCallMeter } from "../llm-meter.js";
import { runInnerLoop } from "../loop.js";
import { loadPrompt } from "../prompts.js";
import { readInside, resolveInside, writeFileInside } from "../safe-path.js";
import type { AclPolicy, MagiTool, ToolResult } from "../tools.js";
import { createBashTool, truncate } from "../tools.js";
import { tryCreateBrowseWebTool } from "./browse-web.js";
import { createFetchUrlTool } from "./fetch-url.js";
import { tryCreateSearchWebTool } from "./search-web.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum LLM calls in the Research sub-loop before forcing synthesis. */
const RESEARCH_MAX_TURNS = 10;

/** How long one Research call may run before the loop cancels it. */
const RESEARCH_MAX_RUNTIME_MS = 10 * 60_000;

/** Default cache freshness for time-sensitive data (market prices, news). */
const DEFAULT_MAX_AGE_HOURS = 12;
/** Cap per context file read into the prompt — larger inputs are truncated and flagged. */
const CONTEXT_FILE_MAX_BYTES = 5_000_000;

/**
 * Every `context_files`/`output_path` entry is read or written by the daemon
 * process (this tool runs in-process, not through the sudo child), so each
 * must physically land inside one of the agent's permitted roots — a symlink
 * in shared/ to /proc/self/environ would otherwise put the daemon's
 * environment into the prompt. The returned map remembers which root matched
 * so the read/write helpers re-check at open time (O_NOFOLLOW).
 */
export function containResearchPaths(
	permittedPaths: string[],
	paths: string[],
): { rootOf: Map<string, string> } | { rejected: string } {
	const rootOf = new Map<string, string>();
	for (const p of paths) {
		const abs = resolve(p);
		const root = permittedPaths.find((pp) => {
			try {
				resolveInside(pp, abs);
				return true;
			} catch {
				return false;
			}
		});
		if (!root) return { rejected: p };
		rootOf.set(p, root);
	}
	return { rootOf };
}

/** One `## Context:` section per file; a file that cannot be read says so in the prompt rather than vanishing. */
export function readContextSections(
	rootOf: Map<string, string>,
	contextFiles: string[],
): string[] {
	return contextFiles.map((filePath) => {
		try {
			const read = readInside(
				rootOf.get(filePath) as string,
				resolve(filePath),
				{
					maxBytes: CONTEXT_FILE_MAX_BYTES,
				},
			);
			const label = filePath.split("/").pop() ?? filePath;
			const note = read.truncated
				? `\n\n[truncated at ${CONTEXT_FILE_MAX_BYTES} bytes]`
				: "";
			return `## Context: ${label}\n\n${read.bytes.toString("utf-8")}${note}`;
		} catch (e) {
			return `## Context: ${filePath}\n\n(not read: ${(e as Error).message})`;
		}
	});
}

export function writeFinding(
	rootOf: Map<string, string>,
	outputPath: string,
	text: string,
): void {
	try {
		writeFileInside(
			rootOf.get(outputPath) as string,
			resolve(outputPath),
			text,
		);
	} catch (e) {
		console.warn(
			`[research] Failed to write output_path ${outputPath}: ${(e as Error).message}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Research index types
// ---------------------------------------------------------------------------

export interface ResearchEntry {
	slug: string;
	question: string;
	/** First 500 chars of the finding — full text in the .md file. */
	answer: string;
	sources: string[];
	savedAt: string;
	agentId: string;
}

// ---------------------------------------------------------------------------
// Index helpers
// ---------------------------------------------------------------------------

function researchDir(sharedDir: string): string {
	return join(sharedDir, "research");
}

function indexPath(sharedDir: string): string {
	return join(researchDir(sharedDir), "index.json");
}

function ensureResearchDir(sharedDir: string): void {
	const dir = researchDir(sharedDir);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadIndex(sharedDir: string): ResearchEntry[] {
	const p = indexPath(sharedDir);
	if (!existsSync(p)) return [];
	try {
		return JSON.parse(readFileSync(p, "utf-8")) as ResearchEntry[];
	} catch (e) {
		// RS3: the next save would overwrite a corrupt index with one entry,
		// losing every cached finding's index row; keep the bad file aside.
		const aside = `${p}.corrupt-${Date.now()}`;
		try {
			renameSync(p, aside);
		} catch {
			// Already moved by a concurrent reader; nothing left to keep.
		}
		console.warn(
			`[research] index.json was unreadable (${(e as Error).message}) — moved to ${aside}, starting a new index`,
		);
		return [];
	}
}

function normalise(q: string): string {
	return q.toLowerCase().trim().replace(/\s+/g, " ");
}

function findCached(
	index: ResearchEntry[],
	question: string,
	maxAgeHours: number,
): ResearchEntry | undefined {
	const key = normalise(question);
	const cutoff = Date.now() - maxAgeHours * 3_600_000;
	return index.find(
		(e) =>
			normalise(e.question) === key && new Date(e.savedAt).getTime() >= cutoff,
	);
}

function slugify(question: string): string {
	return (
		question
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 60) +
		"-" +
		Date.now().toString(36)
	);
}

function saveEntry(
	sharedDir: string,
	entry: ResearchEntry,
	fullAnswer: string,
): void {
	ensureResearchDir(sharedDir);

	// Write full finding to its own .md file.
	const mdPath = join(researchDir(sharedDir), `${entry.slug}.md`);
	const header = [
		`# Research: ${entry.question}`,
		``,
		`**Agent:** ${entry.agentId}  **Date:** ${entry.savedAt}`,
		`**Sources:** ${entry.sources.join(", ") || "(none recorded)"}`,
		``,
		`---`,
		``,
	].join("\n");
	writeFileSync(mdPath, header + fullAnswer, "utf-8");

	// Append to index: read-modify-write, written to a temp file and renamed
	// so a reader never sees a half-written index. Two Research calls saving
	// at the same moment (agent + Tool API) can still lose one row; the .md
	// finding itself is never lost (RS3).
	const index = loadIndex(sharedDir);
	index.push(entry);
	const tmp = `${indexPath(sharedDir)}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(index, null, 2), "utf-8");
	renameSync(tmp, indexPath(sharedDir));
}

// ---------------------------------------------------------------------------
// Research system prompt
// ---------------------------------------------------------------------------

/**
 * The sub-loop's system prompt. With context files, the sub-loop is told to
 * fetch the URLs in them rather than call SearchWeb (URL discovery is already
 * done).
 */
export function researchSystemPrompt(
	sharedDir: string,
	contextMode: boolean,
): string {
	const base = loadPrompt("research.md", {
		sharedDir,
		maxTurns: RESEARCH_MAX_TURNS,
	});
	return contextMode
		? `${base}\n\n${loadPrompt("research-context-only.md")}`
		: base;
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function ok(text: string): ToolResult {
	return { content: [{ type: "text", text: truncate(text) }] };
}

function toolErr(text: string): ToolResult {
	return { content: [{ type: "text", text: truncate(text) }], isError: true };
}

/** Extract all URLs from the last assistant message's text blocks. */
function extractSources(text: string): string[] {
	const urlRe = /https?:\/\/[^\s)"]+/g;
	return [...new Set(text.match(urlRe) ?? [])];
}

/** Extract the final text response from a completed inner loop. */
function extractFinding(
	messages: import("@mariozechner/pi-ai").Message[],
): string {
	const last = [...messages]
		.reverse()
		.find((m): m is AssistantMessage => m.role === "assistant");
	if (!last) return "(no finding — research loop produced no response)";
	return last.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("")
		.trim();
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * The sub-loop's stateless tools, built once per Research tool and reused
 * across calls: FetchUrl (metered against the calling turn), Bash rooted at
 * sharedDir (artifacts, research index), and SearchWeb when configured —
 * minus anything the calling agent has disabled (RS1).
 */
function statelessResearchTools(
	visionModel: Model<string>,
	sharedDir: string,
	acl: AclPolicy,
	disabled: ReadonlySet<string>,
	meter: LlmCallMeter | undefined,
): MagiTool[] {
	const searchWebTool = tryCreateSearchWebTool();
	return [
		createFetchUrlTool(visionModel, sharedDir, [], { meter }),
		createBashTool(sharedDir, acl),
		...(searchWebTool ? [searchWebTool] : []),
	].filter((t) => !disabled.has(t.name));
}

const RESEARCH_PARAMS = Type.Object({
	question: Type.String({
		description:
			"The specific research question to answer. Be precise — exact values, " +
			"dates, and entities produce better results than vague topics.",
	}),
	max_age_hours: Type.Optional(
		Type.Number({
			description:
				"Maximum age in hours of a cached finding to accept. " +
				"Default: 12 (suitable for market data). " +
				"Use 168 (1 week) for stable facts. Use 1 for breaking news.",
		}),
	),
	context_files: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Paths to files to inject as context into the research sub-loop. " +
				"When provided, the sub-loop is instructed to fetch URLs from these " +
				"files rather than calling SearchWeb (SearchWeb is disabled). " +
				"All paths must be within the agent's permitted paths.",
		}),
	),
	output_path: Type.Optional(
		Type.String({
			description:
				"If provided, the finding text is written to this file path in " +
				"addition to the research cache. Must be within permitted paths.",
		}),
	),
});

/** A cached finding young enough to reuse: its header line and full text (from the .md file when present). */
function readCachedFinding(
	sharedDir: string,
	question: string,
	maxAge: number,
): { header: string; answer: string } | null {
	const cached = findCached(loadIndex(sharedDir), question, maxAge);
	if (!cached) return null;
	const mdFile = join(researchDir(sharedDir), `${cached.slug}.md`);
	let answer = cached.answer;
	if (existsSync(mdFile)) {
		try {
			const raw = readFileSync(mdFile, "utf-8");
			const sep = raw.indexOf("\n---\n");
			answer = sep !== -1 ? raw.slice(sep + 5).trim() : raw.trim();
		} catch {
			// Fall back to truncated answer in index.
		}
	}
	return {
		header: `[Cached finding — ${cached.agentId}, ${new Date(cached.savedAt).toISOString().slice(0, 16)}]`,
		answer,
	};
}

/** The sub-loop's task: the question, preceded by any context files' contents. */
function researchTask(question: string, contextSections: string[]): string {
	return contextSections.length > 0
		? `${contextSections.join("\n\n---\n\n")}\n\n---\n\n## Question\n\n${question}`
		: question;
}

/** Why Research came back empty — usually the call limit, not a missing key (RS5). */
function noFindingMessage(turnCount: number): string {
	return turnCount >= RESEARCH_MAX_TURNS
		? `Research used all ${RESEARCH_MAX_TURNS} of its calls without writing a finding — narrow the question, or pass context_files with the sources to read.`
		: "Research ended without writing a finding (the model stopped without an answer, or the run was aborted).";
}

/** Save the finding to the research cache; a failure is logged, not fatal — the finding is still returned. */
function cacheFinding(
	sharedDir: string,
	question: string,
	finding: string,
	agentId: string,
): void {
	const entry: ResearchEntry = {
		slug: slugify(question),
		question,
		answer: finding.slice(0, 500),
		sources: extractSources(finding),
		savedAt: new Date().toISOString(),
		agentId,
	};
	try {
		saveEntry(sharedDir, entry, finding);
	} catch (e) {
		console.warn(`[research] Failed to save finding: ${(e as Error).message}`);
	}
}

function researchDescription(sharedDir: string): string {
	return (
		"Delegate a research question to a specialist sub-agent that searches the web, " +
		"fetches sources (including JS-rendered pages via BrowseWeb), and returns a " +
		"concise finding (200–500 words + source URLs). " +
		"All intermediate web calls are isolated — they do not appear in your context. " +
		"Findings are cached in the shared workspace; check the index before calling: " +
		"`cat " +
		sharedDir +
		"/research/index.json 2>/dev/null | head -100`\n\n" +
		"Use this tool instead of calling SearchWeb, FetchUrl, or BrowseWeb directly. " +
		"It is far more token-efficient: only the synthesised finding enters your context."
	);
}

interface ResearchLoopDeps {
	model: Model<string>;
	visionModel: Model<string>;
	sharedDir: string;
	statelessTools: MagiTool[];
	disabled: ReadonlySet<string>;
	onSubLoopMessage?: (toolUseId: string, msg: Message) => Promise<void>;
	onSubLoopLlmCall?: LlmCallMeter;
}

/**
 * One research sub-loop. BrowseWeb is stateful (a browser session): a fresh
 * handle per call, closed whether the sub-loop succeeds or fails.
 */
async function runResearchLoop(
	deps: ResearchLoopDeps,
	run: { task: string; systemPrompt: string },
	signal: AbortSignal | undefined,
	toolUseId: string,
): Promise<Awaited<ReturnType<typeof runInnerLoop>>> {
	const { onSubLoopMessage } = deps;
	const browseHandle = deps.disabled.has("BrowseWeb")
		? undefined
		: tryCreateBrowseWebTool(deps.visionModel, deps.sharedDir);
	try {
		return await runInnerLoop({
			model: deps.model,
			getSystemPrompt: () => run.systemPrompt,
			task: run.task,
			tools: browseHandle
				? [...deps.statelessTools, browseHandle.tool]
				: deps.statelessTools,
			signal,
			maxTurns: RESEARCH_MAX_TURNS,
			onMessage: onSubLoopMessage
				? async (msg) => {
						await onSubLoopMessage(toolUseId, msg);
					}
				: undefined,
			onLlmCall: deps.onSubLoopLlmCall,
		});
	} finally {
		await browseHandle?.close();
	}
}

/**
 * Create the Research agentic tool.
 *
 * @param model     - LLM used for the research sub-loop (same as main agent).
 * @param sharedDir - Mission shared directory; research index and findings are
 *                    written here under research/.
 * @param acl       - ACL policy for Bash access (sharedDir only — no workdir).
 * @param opts      - Optional callbacks for sub-loop message observation.
 */
export function createResearchTool(
	model: Model<string>,
	sharedDir: string,
	acl: AclPolicy,
	opts?: {
		/** Vision model for BrowseWeb and FetchUrl image captioning. Defaults to model. */
		visionModel?: Model<string>;
		onSubLoopMessage?: (toolUseId: string, msg: Message) => Promise<void>;
		/** Meters every sub-loop LLM call against the calling agent's turn (COST-1). */
		onSubLoopLlmCall?: LlmCallMeter;
		/**
		 * The calling agent's disabledTools. The sub-loop must not hand back a
		 * tool the operator switched off for this agent (RS1) — Research would
		 * otherwise be a way around the switch.
		 */
		disabledTools?: readonly string[];
	},
): MagiTool {
	const visionModel = opts?.visionModel ?? model;
	const disabled = new Set(opts?.disabledTools ?? []);
	const statelessTools = statelessResearchTools(
		visionModel,
		sharedDir,
		acl,
		disabled,
		opts?.onSubLoopLlmCall,
	);

	const loop: ResearchLoopDeps = {
		model,
		visionModel,
		sharedDir,
		statelessTools,
		disabled,
		onSubLoopMessage: opts?.onSubLoopMessage,
		onSubLoopLlmCall: opts?.onSubLoopLlmCall,
	};

	return {
		name: "Research",
		description: researchDescription(sharedDir),
		parameters: RESEARCH_PARAMS,
		// A sub-agent of up to RESEARCH_MAX_TURNS calls needs more than the
		// loop's 2-minute default; past it, the call is now cancelled (T3)
		// rather than left running unobserved.
		maxRuntimeMs: () => RESEARCH_MAX_RUNTIME_MS,

		async execute(id, rawArgs, signal) {
			const args = rawArgs as {
				question: string;
				max_age_hours?: number;
				context_files?: string[];
				output_path?: string;
			};
			const question = args.question?.trim();
			if (!question) return toolErr("Research: question is required");

			const contextFiles = args.context_files ?? [];
			const outputPath = args.output_path;

			const contained = containResearchPaths(acl.permittedPaths ?? [], [
				...contextFiles,
				...(outputPath ? [outputPath] : []),
			]);
			if ("rejected" in contained) {
				return toolErr(
					`Research: path not within permitted paths: ${contained.rejected}`,
				);
			}
			const { rootOf } = contained;
			const writeOutput = (text: string): void => {
				if (outputPath) writeFinding(rootOf, outputPath, text);
			};

			// Context files mean a fresh answer: the cache is skipped.
			const contextMode = contextFiles.length > 0;
			if (!contextMode) {
				const cached = readCachedFinding(
					sharedDir,
					question,
					args.max_age_hours ?? DEFAULT_MAX_AGE_HOURS,
				);
				if (cached) {
					writeOutput(cached.answer);
					return ok(`${cached.header}\n\n${cached.answer}`);
				}
			}

			const run = {
				task: researchTask(
					question,
					contextMode ? readContextSections(rootOf, contextFiles) : [],
				),
				systemPrompt: researchSystemPrompt(sharedDir, contextMode),
			};
			let loopResult: Awaited<ReturnType<typeof runInnerLoop>>;
			try {
				loopResult = await runResearchLoop(loop, run, signal, id as string);
			} catch (e) {
				return toolErr(
					`Research sub-loop failed: ${e instanceof Error ? e.message : String(e)}`,
				);
			}

			const finding = extractFinding(loopResult.messages);
			if (!finding) {
				return toolErr(noFindingMessage(loopResult.turnCount));
			}
			writeOutput(finding);
			cacheFinding(sharedDir, question, finding, acl.agentId);
			return ok(finding);
		},
	};
}
