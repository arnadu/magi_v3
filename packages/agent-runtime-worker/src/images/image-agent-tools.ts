/**
 * The image sub-agent's three tools and the job state they share
 * (image-agent.ts runs the loop). Each tool enforces the job's budget
 * itself: `generate_image` refuses past `maxImages` or when the model's
 * ceiling price would pass `maxUsd`, `critique_candidates` once `maxUsd` is
 * spent; `finish` marks the job done so the loop stops before another call.
 */

import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import {
	type LlmCallMeter,
	meteredCompleteSimple,
	resolveEventCost,
} from "../llm-meter.js";
import { loadPrompt } from "../prompts.js";
import type { MagiTool, ToolResult } from "../tools.js";
import type { ImageAgentDeps, ImageJobRequest } from "./image-agent.js";
import {
	ASPECT_RATIOS,
	type AspectRatio,
	type GenerateImageResult,
	generateImage,
	type ImageReference,
	imageMeterEvent,
	MAX_REFERENCE_IMAGES,
} from "./image-client.js";
import type { ImageJob } from "./image-job.js";
import { IMAGE_MENU, imageMenuEntry } from "./image-models.js";

export const MAX_SUMMARY_CHARS = 1500;
/** One generation (up to the client's 120 s) plus writing it. */
export const GENERATE_TOOL_TIMEOUT_MS = 150_000;

export function usd(n: number): string {
	return `$${n.toFixed(3)}`;
}

const MAX_CRITIQUE_CANDIDATES = 6;
const MAX_NOTE_CHARS = 500;
const CRITIQUE_MAX_TOKENS = 4000;
/** A raw raster sent for critique when no preview can be rendered (provider limit ~5 MB base64). */
const MAX_RAW_CRITIQUE_BYTES = 3_500_000;

function ok(text: string): ToolResult {
	return { content: [{ type: "text", text }] };
}

function err(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

/** The mutable state of one job, shared by the tools and the loop gate. */
export class JobRun {
	finished = false;
	stopDetail?: string;
	readonly previews = new Map<number, Buffer>();
	private readonly refs = new Map<string, ImageReference>();

	constructor(
		readonly deps: ImageAgentDeps,
		readonly req: ImageJobRequest,
		readonly job: ImageJob,
	) {
		for (const r of req.references) this.refs.set(r.label, r);
	}

	get spent(): number {
		return this.job.manifest.totals.totalUsd;
	}

	/** Why a generation with this model is refused, or undefined when it may run. */
	generationRefusal(modelId: string): string | undefined {
		const { maxImages, maxUsd } = this.req;
		if (this.finished) return "The job is finished.";
		const images = this.job.manifest.totals.images;
		if (images >= maxImages) {
			return `Image budget reached (${images} of ${maxImages}). Call finish.`;
		}
		const entry = imageMenuEntry(modelId);
		if (!entry) return `${modelId} is not on the menu.`;
		const allowed = this.deps.allowedKinds;
		if (allowed && !allowed.includes(entry.kind)) {
			return `Kind ${entry.kind} is not enabled for this mission.`;
		}
		if (this.spent + entry.ceilingUsdPerImage <= maxUsd) return undefined;
		if (!this.anyModelFits()) {
			// Nothing on the menu fits what is left: end the job at the next gate.
			this.stopDetail = `budget of ${usd(maxUsd)} reached`;
		}
		return `${modelId} may cost up to ${usd(entry.ceilingUsdPerImage)}; the job has spent ${usd(this.spent)} of ${usd(maxUsd)}. Choose a cheaper model or call finish.`;
	}

	/** Whether the cheapest model the mission allows still fits in the job's budget. */
	anyModelFits(): boolean {
		const allowed = this.deps.allowedKinds;
		return IMAGE_MENU.some(
			(e) =>
				(!allowed || allowed.includes(e.kind)) &&
				this.spent + e.ceilingUsdPerImage <= this.req.maxUsd,
		);
	}

	/** Charges a sub-agent call to the job's total and the calling turn. */
	readonly meterAgentCall: LlmCallMeter = async (event) => {
		const { cost } = resolveEventCost(
			event,
			event.model ?? this.deps.agentModel,
		);
		this.job.addAgentCost(cost.totalCostUsd);
		await this.deps.meter?.(event);
	};

	/** Previews for these candidates, rendering the missing ones in one browser session. */
	async previewsFor(ns: number[], signal?: AbortSignal): Promise<void> {
		const render = this.deps.renderPreviews;
		const missing = ns.filter((n) => !this.previews.has(n));
		if (!render || missing.length === 0) return;
		try {
			const sources = missing.map((n) => this.job.readCandidate(n));
			const out = await render(sources, signal);
			missing.forEach((n, i) => {
				const p = out[i];
				if (p) this.previews.set(n, p);
			});
		} catch (e) {
			console.warn(
				`[image-agent] preview rendering failed for job ${this.job.manifest.jobId}: ${(e as Error).message} — critique and contact sheet fall back to the original files`,
			);
		}
	}

	/** A reference by label: a caller reference, the parent, or one of this job's candidates. */
	async reference(
		label: string,
		signal?: AbortSignal,
	): Promise<ImageReference> {
		const known = this.refs.get(label);
		if (known) return known;
		const m = label.match(/^candidate-(\d+)$/);
		if (!m) throw new Error(`Unknown reference "${label}"`);
		const n = Number(m[1]);
		const c = this.job.readCandidate(n);
		if (c.mimeType !== "image/svg+xml") {
			return { mimeType: c.mimeType, data: c.bytes.toString("base64") };
		}
		await this.previewsFor([n], signal);
		const preview = this.previews.get(n);
		if (!preview) {
			throw new Error(
				`${label} is an SVG and no raster preview could be made to pass it as a reference`,
			);
		}
		return { mimeType: "image/jpeg", data: preview.toString("base64") };
	}
}

const GENERATE_PARAMS = Type.Object({
	model: Type.String({ description: "A model id from the menu." }),
	prompt: Type.String({
		description: "The full prompt for this model family.",
	}),
	references: Type.Optional(
		Type.Array(Type.String(), {
			maxItems: MAX_REFERENCE_IMAGES,
			description:
				"Reference image labels: ref-1…, parent, or candidate-N of this job.",
		}),
	),
	aspectRatio: Type.Optional(
		Type.Union(ASPECT_RATIOS.map((a) => Type.Literal(a))),
	),
	rationale: Type.Optional(
		Type.String({ description: "One line: why this model and prompt." }),
	),
});

function generateTool(run: JobRun): MagiTool {
	const { deps, req, job } = run;
	const generate = deps.generate ?? ((r) => generateImage(r));
	return {
		name: "generate_image",
		description:
			"Generate one image with a menu model. Refused once the job's image count or budget is reached.",
		parameters: GENERATE_PARAMS,
		maxRuntimeMs: () => GENERATE_TOOL_TIMEOUT_MS,
		async execute(_id, raw, signal) {
			const a = raw as {
				model: string;
				prompt: string;
				references?: string[];
				aspectRatio?: AspectRatio;
				rationale?: string;
			};
			const refusal = run.generationRefusal(a.model);
			if (refusal) return err(refusal);
			const t = job.manifest.totals;
			const labels = a.references ?? [];
			let references: ImageReference[];
			try {
				references = await Promise.all(
					labels.map((l) => run.reference(l, signal)),
				);
			} catch (e) {
				return err((e as Error).message);
			}
			await deps.beforeLlmCall?.();
			let result: GenerateImageResult;
			try {
				result = await generate({
					modelId: a.model,
					prompt: a.prompt,
					references,
					aspectRatio: a.aspectRatio ?? req.aspectRatio,
					signal,
				});
			} catch (e) {
				return err(`Generation failed: ${(e as Error).message}`);
			}
			const share = result.costUsd / result.images.length;
			const added = result.images.map((img) =>
				job.addCandidate(img, {
					model: a.model,
					prompt: a.prompt,
					...(a.rationale
						? { rationale: a.rationale.slice(0, MAX_NOTE_CHARS) }
						: {}),
					references: labels,
					...(a.aspectRatio ? { aspectRatio: a.aspectRatio } : {}),
					costUsd: share,
					costEstimated: result.costEstimated,
					...(result.responseId ? { responseId: result.responseId } : {}),
				}),
			);
			try {
				await deps.meter?.(imageMeterEvent(result, a.prompt));
			} catch (e) {
				// A hard limit or a metering failure: keep what was made, stop the job.
				run.stopDetail = `stopped after charging a generation: ${(e as Error).message}`;
				run.finished = true;
				return err(run.stopDetail);
			}
			const names = added.map((c) => `candidate-${c.n} (${c.file})`).join(", ");
			return ok(
				`Made ${names} with ${a.model} for ${usd(result.costUsd)}${result.costEstimated ? " (estimated)" : ""}${result.text ? `; the model also said: ${result.text.slice(0, 300)}` : ""}. Job total ${usd(run.spent)} of ${usd(req.maxUsd)}, ${t.images} of ${req.maxImages} images.`,
			);
		},
	};
}

const CRITIQUE_PARAMS = Type.Object({
	candidates: Type.Optional(
		Type.Array(Type.Integer({ minimum: 1 }), {
			maxItems: MAX_CRITIQUE_CANDIDATES,
			description: "Candidate numbers to compare; default: the latest ones.",
		}),
	),
	focus: Type.Optional(
		Type.String({ description: "What to look at most closely." }),
	),
});

/** The image blocks for a critique, with a note for each candidate that could not be shown. */
function critiqueContent(
	run: JobRun,
	ns: number[],
): { content: (TextContent | ImageContent)[]; shown: number[] } {
	const content: (TextContent | ImageContent)[] = [];
	const shown: number[] = [];
	for (const n of ns) {
		const c = run.job.manifest.candidates.find((x) => x.n === n);
		if (!c) continue;
		const preview = run.previews.get(n);
		let image: ImageContent | undefined;
		if (preview) {
			image = {
				type: "image",
				mimeType: "image/jpeg",
				data: preview.toString("base64"),
			};
		} else if (
			c.mimeType !== "image/svg+xml" &&
			c.bytes <= MAX_RAW_CRITIQUE_BYTES
		) {
			const raw = run.job.readCandidate(n);
			image = {
				type: "image",
				mimeType: raw.mimeType,
				data: raw.bytes.toString("base64"),
			};
		}
		content.push({
			type: "text",
			text: image
				? `Candidate ${n} (${c.model}):`
				: `Candidate ${n} (${c.model}): could not be shown.`,
		});
		if (image) {
			content.push(image);
			shown.push(n);
		}
	}
	return { content, shown };
}

function critiqueTool(run: JobRun): MagiTool {
	const { deps, req, job } = run;
	return {
		name: "critique_candidates",
		description:
			"Look at candidates side by side and get a critique against the brief: defects, scores, and a refinement instruction.",
		parameters: CRITIQUE_PARAMS,
		async execute(_id, raw, signal) {
			const a = raw as { candidates?: number[]; focus?: string };
			if (run.finished) return err("The job is finished.");
			if (run.spent >= req.maxUsd) return err("Budget reached. Call finish.");
			const all = job.manifest.candidates.map((c) => c.n);
			const ns = (a.candidates?.length ? a.candidates : all).slice(
				-MAX_CRITIQUE_CANDIDATES,
			);
			if (ns.length === 0) return err("No candidates yet.");
			await run.previewsFor(ns, signal);
			const { content, shown } = critiqueContent(run, ns);
			if (shown.length === 0)
				return err("None of these candidates could be shown.");
			await deps.beforeLlmCall?.();
			const before = run.spent;
			const response = await meteredCompleteSimple(
				deps.agentModel,
				{
					systemPrompt: loadPrompt("image-critique.md"),
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: `## Brief\n\n${req.brief}${a.focus ? `\n\n## Focus\n\n${a.focus}` : ""}`,
								},
								...content,
							],
							timestamp: Date.now(),
						},
					],
				},
				{ signal, maxTokens: CRITIQUE_MAX_TOKENS },
				run.meterAgentCall,
				deps.completeFn,
			);
			const text = response.content
				.filter((b): b is TextContent => b.type === "text")
				.map((b) => b.text)
				.join("")
				.trim();
			if (
				response.stopReason === "error" ||
				response.stopReason === "aborted" ||
				!text
			) {
				return err(
					`Critique failed: ${response.errorMessage ?? response.stopReason}`,
				);
			}
			job.addCritique({ candidates: shown, text, costUsd: run.spent - before });
			return ok(text);
		},
	};
}

const FINISH_PARAMS = Type.Object({
	summary: Type.String({
		description:
			"One paragraph for the caller: what was made, which candidates you recommend and why, known limits.",
	}),
	recommended: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
	notes: Type.Optional(
		Type.Array(
			Type.Object({
				candidate: Type.Integer({ minimum: 1 }),
				note: Type.String(),
			}),
		),
	),
});

function finishTool(run: JobRun): MagiTool {
	const m = run.job.manifest;
	return {
		name: "finish",
		description:
			"End the job: record the summary, the recommended candidates and a note per candidate.",
		parameters: FINISH_PARAMS,
		async execute(_id, raw) {
			const a = raw as {
				summary: string;
				recommended?: number[];
				notes?: { candidate: number; note: string }[];
			};
			const exists = new Set(m.candidates.map((c) => c.n));
			m.summary = a.summary.trim().slice(0, MAX_SUMMARY_CHARS);
			m.recommended = (a.recommended ?? []).filter((n) => exists.has(n));
			for (const { candidate, note } of a.notes ?? []) {
				const c = m.candidates.find((x) => x.n === candidate);
				if (c) c.note = note.trim().slice(0, MAX_NOTE_CHARS);
			}
			run.finished = true;
			return ok("Recorded. The job is complete.");
		},
	};
}

/** The tools the sub-agent gets — these three and no others. */
export function imageAgentTools(run: JobRun): MagiTool[] {
	return [generateTool(run), critiqueTool(run), finishTool(run)];
}
