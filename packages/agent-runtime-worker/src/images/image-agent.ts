/**
 * The image sub-agent (ADR-0035): a short inner loop with three tools —
 * `generate_image`, `critique_candidates`, `finish` — and nothing else. No
 * Bash, no web, no messaging, no file access beyond the job folder and the
 * reference images the caller passed, so a brief or a reference image that
 * carries injected instructions has nothing to reach.
 *
 * Budgets are enforced by the tools themselves (they refuse past
 * `maxImages` or `maxUsd`) and by the loop gate (no further LLM call once
 * the job has spent `maxUsd`), on top of the turn limit and the caller's
 * time limit. Every generation and every sub-agent call is charged to the
 * calling agent's turn through its meter, so the mission cap and the
 * agent's limits see it. Whatever ends the job, the manifest and the
 * contact sheet describe what was made.
 */

import type { ImageKind } from "@magi/agent-config";
import type {
	AssistantMessage,
	Message,
	Model,
	TextContent,
} from "@mariozechner/pi-ai";
import type { CompleteFn, LlmCallMeter } from "../llm-meter.js";
import { runInnerLoop } from "../loop.js";
import { loadPrompt } from "../prompts.js";
import {
	GENERATE_TOOL_TIMEOUT_MS,
	imageAgentTools,
	JobRun,
	MAX_SUMMARY_CHARS,
	usd,
} from "./image-agent-tools.js";
import type {
	AspectRatio,
	GenerateImageRequest,
	GenerateImageResult,
	ImageReference,
} from "./image-client.js";
import { ImageJob, type JobManifest } from "./image-job.js";
import { IMAGE_MENU } from "./image-models.js";
import type { RenderPreviews } from "./image-preview.js";

export const IMAGE_AGENT_MAX_TURNS = 20;

export interface LabelledReference extends ImageReference {
	/** How the sub-agent names it: ref-1…ref-3, or parent. */
	label: string;
	/** Shown to the sub-agent: the caller's file name, or the parent job. */
	description: string;
}

export interface ImageJobRequest {
	brief: string;
	options: number;
	kind?: ImageKind;
	aspectRatio?: AspectRatio;
	references: LabelledReference[];
	parent?: { jobId: string; candidate: number };
	maxImages: number;
	maxUsd: number;
}

export interface ImageAgentDeps {
	agentModel: Model<string>;
	sharedDir: string;
	agentId: string;
	/** The kinds the mission allows; all when absent. */
	allowedKinds?: readonly ImageKind[];
	/** The calling turn's meter: every generation and sub-agent call is charged to it. */
	meter?: LlmCallMeter;
	/** The mission's spend-cap pause, before each sub-agent call and each generation. */
	beforeLlmCall?: () => Promise<void>;
	onSubLoopMessage?: (msg: Message) => Promise<void>;
	completeFn?: CompleteFn;
	generate?: (req: GenerateImageRequest) => Promise<GenerateImageResult>;
	renderPreviews?: RenderPreviews;
	jobId?: string;
}

export interface ImageJobOutcome {
	manifest: JobManifest;
	/** Paths relative to the shared dir. */
	jobDir: string;
	contactSheet?: string;
}

/** The menu lines the sub-agent may choose from. */
export function menuText(allowed?: readonly ImageKind[]): string {
	return IMAGE_MENU.filter((e) => !allowed || allowed.includes(e.kind))
		.map(
			(e) =>
				`- \`${e.id}\` — ${e.kind}, ${e.tiers.join("/")} tier, returns ${e.output.toUpperCase()}, at most ${usd(e.ceilingUsdPerImage)} per image: ${e.strengths}`,
		)
		.join("\n");
}

export function imageAgentTask(req: ImageJobRequest): string {
	const refs = req.references.length
		? req.references.map((r) => `- \`${r.label}\`: ${r.description}`).join("\n")
		: "- none";
	return `## Brief

${req.brief}

## Deliverable

- Distinct options to deliver: ${req.options}
- Kind of image: ${req.kind ?? "your choice"}
- Aspect ratio: ${req.aspectRatio ?? "your choice"}

## Budget

At most ${req.maxImages} generations and ${usd(req.maxUsd)} in total (generations and your own calls).

## Reference images

${refs}`;
}

/** Text of the last assistant message: the sub-agent's closing words when it never called finish. */
function lastAssistantText(messages: Message[]): string {
	const last = [...messages]
		.reverse()
		.find((m): m is AssistantMessage => m.role === "assistant");
	return (
		last?.content
			.filter((b): b is TextContent => b.type === "text")
			.map((b) => b.text)
			.join("")
			.trim() ?? ""
	);
}

function finalStatus(
	run: JobRun,
	loopError: string | undefined,
	callerAborted: boolean,
): Pick<JobManifest, "status" | "statusDetail"> {
	const some = run.job.manifest.candidates.length > 0;
	const partial = some ? "partial" : "failed";
	if (loopError) return { status: partial, statusDetail: loopError };
	if (callerAborted) {
		return {
			status: partial,
			statusDetail: "aborted (time limit or shutdown)",
		};
	}
	if (run.stopDetail) return { status: partial, statusDetail: run.stopDetail };
	if (run.finished) return { status: some ? "complete" : "failed" };
	return {
		status: partial,
		statusDetail: "the image agent stopped without calling finish",
	};
}

/**
 * Run one image job end to end. Never throws for a failure inside the job:
 * the outcome's manifest says what happened. Throws only when the job
 * folder cannot be created.
 */
export async function runImageJob(
	deps: ImageAgentDeps,
	req: ImageJobRequest,
	signal?: AbortSignal,
): Promise<ImageJobOutcome> {
	const job = ImageJob.create(
		deps.sharedDir,
		{
			createdBy: deps.agentId,
			brief: req.brief,
			options: req.options,
			...(req.kind ? { kind: req.kind } : {}),
			...(req.aspectRatio ? { aspectRatio: req.aspectRatio } : {}),
			budget: { maxImages: req.maxImages, maxUsd: req.maxUsd },
			...(req.parent ? { parent: req.parent } : {}),
		},
		deps.jobId,
	);
	const run = new JobRun(deps, req, job);
	const finishCtl = new AbortController();
	const loopSignal = signal
		? AbortSignal.any([signal, finishCtl.signal])
		: finishCtl.signal;
	let loopError: string | undefined;
	let messages: Message[] = [];
	try {
		const result = await runInnerLoop({
			model: deps.agentModel,
			getSystemPrompt: () =>
				loadPrompt("image-agent.md", {
					menu: menuText(deps.allowedKinds),
					maxTurns: IMAGE_AGENT_MAX_TURNS,
				}),
			task: imageAgentTask(req),
			tools: imageAgentTools(run),
			signal: loopSignal,
			maxTurns: IMAGE_AGENT_MAX_TURNS,
			toolTimeoutMs: GENERATE_TOOL_TIMEOUT_MS,
			onMessage: deps.onSubLoopMessage
				? async (msg) => {
						await deps.onSubLoopMessage?.(msg);
					}
				: undefined,
			onLlmCall: run.meterAgentCall,
			// finish ends the loop here, before another (billed) call is made.
			beforeLlmCall: async () => {
				if (!run.finished && run.spent >= req.maxUsd) {
					run.stopDetail = `budget of ${usd(req.maxUsd)} reached`;
				}
				if (run.finished || run.stopDetail) {
					finishCtl.abort();
					return;
				}
				await deps.beforeLlmCall?.();
			},
			completeFn: deps.completeFn,
		});
		messages = result.messages;
	} catch (e) {
		loopError = `image agent failed: ${(e as Error).message}`;
	}

	const m = job.manifest;
	Object.assign(m, finalStatus(run, loopError, signal?.aborted ?? false));
	if (!m.summary) {
		const closing = lastAssistantText(messages);
		if (closing) m.summary = closing.slice(0, MAX_SUMMARY_CHARS);
	}
	if (!signal?.aborted) {
		await run.previewsFor(
			m.candidates.map((c) => c.n),
			signal,
		);
	}
	let contactSheet: string | undefined;
	try {
		job.save();
		contactSheet = job.writeContactSheet(run.previews);
	} catch (e) {
		console.error(
			`[image-agent] writing the manifest or contact sheet of ${m.jobId} failed: ${(e as Error).message} — the candidate files are in place, the summary may be stale`,
		);
	}
	return {
		manifest: m,
		jobDir: job.relDir,
		...(contactSheet ? { contactSheet } : {}),
	};
}
