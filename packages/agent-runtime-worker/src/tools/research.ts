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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AssistantMessage, Model } from "@mariozechner/pi-ai";
import { runInnerLoop } from "../loop.js";
import { createFetchUrlTool } from "./fetch-url.js";
import { tryCreateSearchWebTool } from "./search-web.js";
import { createBashTool } from "../tools.js";
import type { AclPolicy, MagiTool, ToolResult } from "../tools.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum LLM calls in the Research sub-loop before forcing synthesis. */
const RESEARCH_MAX_TURNS = 10;

/** Default cache freshness for time-sensitive data (market prices, news). */
const DEFAULT_MAX_AGE_HOURS = 12;

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
	} catch {
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
			normalise(e.question) === key &&
			new Date(e.savedAt).getTime() >= cutoff,
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

	// Append to index (read-modify-write — safe because agents run sequentially).
	const index = loadIndex(sharedDir);
	index.push(entry);
	writeFileSync(indexPath(sharedDir), JSON.stringify(index, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Research system prompt
// ---------------------------------------------------------------------------

const RESEARCH_SYSTEM_PROMPT = `\
You are a specialist research agent. Your sole job is to answer one specific question \
by searching the web and reading sources. You report to a main analyst agent who is \
waiting for your findings.

## Your approach

1. Before searching, check if relevant artifacts already exist in the shared workspace:
   Use Bash: ls <sharedDir>/artifacts/ 2>/dev/null | grep -i <keyword>
   If an artifact looks relevant, read it with: head -n 100 <path>/content.md

2. Use SearchWeb to find relevant sources (max 2 searches per concept — do not retry \
the same concept with minor variations).

3. Use FetchUrl to retrieve the 2–3 most promising sources.

4. Synthesise your findings into a clear, concise answer.

## Output format

Your final response (when you stop calling tools) MUST contain:
- A direct answer to the question (be specific: numbers, dates, exact values)
- Brief source context (where the data came from, when)
- A "Sources:" section at the end listing the URLs you used
- If exact data is unavailable, say so explicitly and give your best estimate with \
  a confidence level (e.g. "~$127, confidence: medium — most recent data is 2 days old")

## Hard constraints

- You have at most ${RESEARCH_MAX_TURNS} tool calls total. Synthesise with what you \
  have when you approach the limit — do not keep searching.
- Never search for the same concept more than twice.
- Keep your response under 600 words.
- Do not write any files — read only.
`;

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function ok(text: string): ToolResult {
	return { content: [{ type: "text", text }] };
}

function toolErr(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

/** Extract all URLs from the last assistant message's text blocks. */
function extractSources(text: string): string[] {
	const urlRe = /https?:\/\/[^\s\)\"]+/g;
	return [...new Set(text.match(urlRe) ?? [])];
}

/** Extract the final text response from a completed inner loop. */
function extractFinding(messages: import("@mariozechner/pi-ai").Message[]): string {
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
	opts?: { onSubLoopMessage?: (toolUseId: string, msg: import("@mariozechner/pi-ai").Message) => Promise<void> },
): MagiTool {
	// Build the sub-loop tool set once (stateless tools; safe to reuse).
	const searchWebTool = tryCreateSearchWebTool();
	const fetchUrlTool = createFetchUrlTool(model, sharedDir);
	// Bash with sharedDir as cwd — permits reading artifacts, research index, etc.
	const bashTool = createBashTool(sharedDir, acl);

	const subLoopTools: MagiTool[] = [
		fetchUrlTool,
		bashTool,
		...(searchWebTool ? [searchWebTool] : []),
	];

	// Inject sharedDir into the system prompt so the agent knows where to look.
	const systemPrompt = RESEARCH_SYSTEM_PROMPT.replace(/<sharedDir>/g, sharedDir);

	return {
		name: "Research",
		description:
			"Delegate a research question to a specialist sub-agent that searches the web, " +
			"fetches sources, and returns a concise finding (200–500 words + source URLs). " +
			"All intermediate web calls are isolated — they do not appear in your context. " +
			"Findings are cached in the shared workspace; check the index before calling: " +
			"`cat " + sharedDir + "/research/index.json 2>/dev/null | head -100`\n\n" +
			"Use this tool instead of calling SearchWeb or FetchUrl directly. " +
			"It is far more token-efficient: only the synthesised finding enters your context.",
		parameters: Type.Object({
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
		}),

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

			// Validate all paths are within permitted paths.
			const permittedPaths = acl.permittedPaths ?? [];
			for (const p of [...contextFiles, ...(outputPath ? [outputPath] : [])]) {
				const abs = resolve(p);
				const allowed = permittedPaths.some((pp) => abs.startsWith(pp));
				if (!allowed) {
					return toolErr(`Research: path not within permitted paths: ${p}`);
				}
			}

			// When context files are provided, always treat as fresh (maxAge = 0).
			const maxAge = contextFiles.length > 0 ? 0 : (args.max_age_hours ?? DEFAULT_MAX_AGE_HOURS);

			// 1. Check cache (skipped when contextFiles are present — always fresh).
			if (contextFiles.length === 0) {
				const index = loadIndex(sharedDir);
				const cached = findCached(index, question, maxAge);
				if (cached) {
					const mdFile = join(researchDir(sharedDir), `${cached.slug}.md`);
					let fullAnswer = cached.answer;
					if (existsSync(mdFile)) {
						try {
							const raw = readFileSync(mdFile, "utf-8");
							const sep = raw.indexOf("\n---\n");
							fullAnswer = sep !== -1 ? raw.slice(sep + 5).trim() : raw.trim();
						} catch {
							// Fall back to truncated answer in index.
						}
					}
					const result = `[Cached finding — ${cached.agentId}, ${new Date(cached.savedAt).toISOString().slice(0, 16)}]\n\n${fullAnswer}`;
					if (outputPath) {
						try { writeFileSync(outputPath, fullAnswer, "utf-8"); } catch {}
					}
					return ok(result);
				}
			}

			// 2. Build task string, injecting context file contents when provided.
			let task = question;
			if (contextFiles.length > 0) {
				const sections: string[] = [];
				for (const filePath of contextFiles) {
					if (!existsSync(filePath)) continue; // silently skip missing files
					try {
						const content = readFileSync(filePath, "utf-8");
						const label = filePath.split("/").pop() ?? filePath;
						sections.push(`## Context: ${label}\n\n${content}`);
					} catch {
						// Skip unreadable files.
					}
				}
				if (sections.length > 0) {
					task = `${sections.join("\n\n---\n\n")}\n\n---\n\n## Question\n\n${question}`;
				}
			}

			// 3. Choose the effective system prompt.
			// When context files are provided, instruct the sub-loop to use provided
			// URLs rather than calling SearchWeb (which is unnecessary and wastes tokens).
			const effectiveSystemPrompt = contextFiles.length > 0
				? systemPrompt +
				  "\n\n## Context-only mode\n" +
				  "Context files have been provided above. " +
				  "Fetch URLs found in those files using FetchUrl. " +
				  "Do NOT call SearchWeb — all URL discovery is already done. " +
				  "SearchWeb is effectively disabled for this request."
				: systemPrompt;

			// 4. Run research sub-loop.
			let loopResult: Awaited<ReturnType<typeof runInnerLoop>>;
			try {
				loopResult = await runInnerLoop({
					model,
					getSystemPrompt: () => effectiveSystemPrompt,
					task,
					tools: subLoopTools,
					signal,
					maxTurns: RESEARCH_MAX_TURNS,
					onMessage: opts?.onSubLoopMessage
						? async (msg) => { await opts.onSubLoopMessage!(id as string, msg); }
						: undefined,
				});
			} catch (e) {
				return toolErr(
					`Research sub-loop failed: ${e instanceof Error ? e.message : String(e)}`,
				);
			}

			// 5. Extract finding.
			const finding = extractFinding(loopResult.messages);
			if (!finding) {
				return toolErr("Research produced no response. Check SearchWeb API key.");
			}

			// 6. Write to output_path if provided.
			if (outputPath) {
				try {
					writeFileSync(outputPath, finding, "utf-8");
				} catch (e) {
					console.warn(`[research] Failed to write output_path: ${(e as Error).message}`);
				}
			}

			// 7. Persist finding to research cache.
			const slug = slugify(question);
			const entry: ResearchEntry = {
				slug,
				question,
				answer: finding.slice(0, 500),
				sources: extractSources(finding),
				savedAt: new Date().toISOString(),
				agentId: acl.agentId,
			};
			try {
				saveEntry(sharedDir, entry, finding);
			} catch (e) {
				// Persistence failure is non-fatal — still return the finding.
				console.warn(`[research] Failed to save finding: ${(e as Error).message}`);
			}

			return ok(finding);
		},
	};
}
