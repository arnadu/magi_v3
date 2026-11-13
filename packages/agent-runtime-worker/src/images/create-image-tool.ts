/**
 * CreateImage — the agent-facing tool (ADR-0035): one call with a brief; an
 * in-process sub-agent (image-agent.ts) picks models, generates, critiques
 * and refines within a budget, and the caller gets back file paths, the
 * contact sheet and one paragraph — never the images themselves.
 *
 * Reference images are read by the daemon (this tool runs in-process), so
 * each path must land physically inside the agent's workdir or the shared
 * folder (safe-path.ts, no link followed), as for InspectImage.
 */

import { basename, join, resolve } from "node:path";
import type { ImageKind } from "@magi/agent-config";
import { IMAGE_KINDS } from "@magi/agent-config";
import type { Message, Model } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { CompleteFn, LlmCallMeter } from "../llm-meter.js";
import { readInside } from "../safe-path.js";
import { findPermittedBase } from "../tools/inspect-image.js";
import type { MagiTool, ToolResult } from "../tools.js";
import {
	type ImageJobOutcome,
	type ImageJobRequest,
	type LabelledReference,
	runImageJob,
} from "./image-agent.js";
import {
	ASPECT_RATIOS,
	type AspectRatio,
	type GenerateImageRequest,
	type GenerateImageResult,
	MAX_REFERENCE_BYTES,
	MAX_REFERENCE_IMAGES,
	validateReferences,
} from "./image-client.js";
import { readJobCandidate, readJobManifest } from "./image-job.js";
import { createPreviewRenderer, type RenderPreviews } from "./image-preview.js";

export const DEFAULT_OPTIONS = 3;
export const MAX_OPTIONS = 6;
export const DEFAULT_MAX_IMAGES = 8;
export const PLATFORM_MAX_IMAGES = 16;
export const DEFAULT_MAX_USD = 1.5;
export const PLATFORM_MAX_USD = 5;
const MIN_USD = 0.05;
const MAX_BRIEF_CHARS = 4000;
const CREATE_IMAGE_MAX_RUNTIME_MS = 10 * 60_000;

const REFERENCE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
};

export interface CreateImageToolOptions {
	agentModel: Model<string>;
	workdir: string;
	sharedDir: string;
	agentId: string;
	allowedKinds?: readonly ImageKind[];
	meter?: LlmCallMeter;
	beforeLlmCall?: () => Promise<void>;
	onSubLoopMessage?: (toolUseId: string, msg: Message) => Promise<void>;
	/** null: no previews; absent: Chromium when installed. */
	renderPreviews?: RenderPreviews | null;
	completeFn?: CompleteFn;
	generate?: (req: GenerateImageRequest) => Promise<GenerateImageResult>;
}

const PARAMS = Type.Object({
	brief: Type.String({
		description:
			"What the image is for and what it shows: purpose, audience, subject, style, colours, " +
			"exact text to render, deliverable (e.g. isolated logo on plain background, 16:9 hero image).",
	}),
	options: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_OPTIONS,
			description: `Distinct options to deliver (default ${DEFAULT_OPTIONS}).`,
		}),
	),
	kind: Type.Optional(
		Type.Union(
			IMAGE_KINDS.map((k) => Type.Literal(k)),
			{
				description:
					"vector (SVG logos, icons), raster-art (illustrations, photos), raster-instruct (diagrams with text, edits). Default: the image agent chooses.",
			},
		),
	),
	aspectRatio: Type.Optional(
		Type.Union(ASPECT_RATIOS.map((a) => Type.Literal(a))),
	),
	references: Type.Optional(
		Type.Array(Type.String(), {
			maxItems: MAX_REFERENCE_IMAGES,
			description:
				"Paths of reference images (PNG, JPEG or WebP, at most 5 MB) in your workdir or the shared folder: style examples, or an image to edit.",
		}),
	),
	refineJob: Type.Optional(
		Type.String({ description: "A previous job id (img-…) to refine." }),
	),
	refineCandidate: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "The candidate number of refineJob to refine.",
		}),
	),
	maxImages: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: PLATFORM_MAX_IMAGES,
			description: `Most generations for this call (default ${DEFAULT_MAX_IMAGES}).`,
		}),
	),
	maxUsd: Type.Optional(
		Type.Number({
			minimum: MIN_USD,
			maximum: PLATFORM_MAX_USD,
			description: `Most this call may spend, in USD (default ${DEFAULT_MAX_USD}).`,
		}),
	),
});

export type CreateImageArgs = {
	brief: string;
	options?: number;
	kind?: ImageKind;
	aspectRatio?: AspectRatio;
	references?: string[];
	refineJob?: string;
	refineCandidate?: number;
	maxImages?: number;
	maxUsd?: number;
};

function err(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

function clamp(
	v: number | undefined,
	def: number,
	lo: number,
	hi: number,
): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return def;
	return Math.min(hi, Math.max(lo, v));
}

/** Reads the caller's reference images from inside its workdir or the shared folder. */
export function readCallerReferences(
	roots: string[],
	workdir: string,
	paths: string[],
): LabelledReference[] {
	return paths.map((p, i) => {
		const abs = resolve(workdir, p);
		const { base, missing } = findPermittedBase(roots, abs);
		if (!base) {
			throw new Error(
				missing
					? `Reference image not found: ${p}`
					: `Reference image is outside your workdir and the shared folder: ${p}`,
			);
		}
		const ext = abs.split(".").pop()?.toLowerCase() ?? "";
		const mimeType = REFERENCE_MIME[ext];
		if (!mimeType) {
			throw new Error(`Reference image ${p} must be PNG, JPEG or WebP`);
		}
		const read = readInside(base, abs, { maxBytes: MAX_REFERENCE_BYTES });
		if (read.truncated) {
			throw new Error(
				`Reference image ${p} is over ${MAX_REFERENCE_BYTES / 1024 / 1024} MB`,
			);
		}
		return {
			label: `ref-${i + 1}`,
			description: `${basename(abs)} (${mimeType})`,
			mimeType,
			data: read.bytes.toString("base64"),
		};
	});
}

/** The candidate to refine, as a raster reference labelled `parent`. */
async function readParent(
	sharedDir: string,
	jobId: string,
	n: number,
	render: RenderPreviews | undefined,
): Promise<LabelledReference> {
	const manifest = readJobManifest(sharedDir, jobId);
	const image = readJobCandidate(sharedDir, manifest, n);
	const c = manifest.candidates.find((x) => x.n === n);
	const description = `candidate ${n} of job ${jobId} (${c?.model ?? "unknown model"}); its prompt: ${(c?.prompt ?? "").slice(0, 400)}`;
	if (image.mimeType !== "image/svg+xml") {
		return {
			label: "parent",
			description,
			mimeType: image.mimeType,
			data: image.bytes.toString("base64"),
		};
	}
	if (!render) {
		throw new Error(
			`Candidate ${n} of ${jobId} is an SVG and no browser is available to turn it into a reference`,
		);
	}
	const [preview] = await render([image]);
	return {
		label: "parent",
		description: `${description} (SVG, passed as a rendered JPEG)`,
		mimeType: "image/jpeg",
		data: preview.toString("base64"),
	};
}

export function outcomeText(sharedDir: string, o: ImageJobOutcome): string {
	const m = o.manifest;
	const t = m.totals;
	const rec = new Set(m.recommended ?? []);
	const lines = [
		`Image job ${m.jobId} — ${m.status}${m.statusDetail ? `: ${m.statusDetail}` : ""}. ${t.images} image(s), total $${t.totalUsd.toFixed(3)}${t.estimated ? " (partly estimated)" : ""}.`,
	];
	if (o.contactSheet)
		lines.push(`Contact sheet: ${join(sharedDir, o.contactSheet)}`);
	if (m.candidates.length) {
		lines.push("Candidates:");
		for (const c of m.candidates) {
			lines.push(
				`- ${join(sharedDir, o.jobDir, c.file)} — ${c.model}${rec.has(c.n) ? " — recommended" : ""}${c.note ? ` — ${c.note}` : ""}`,
			);
		}
	}
	if (m.summary) lines.push("", `Image agent's summary: ${m.summary}`);
	if (m.candidates.length) {
		lines.push(
			"",
			`To refine a candidate: CreateImage with refineJob "${m.jobId}", refineCandidate N and a brief saying what to change.`,
		);
	}
	return lines.join("\n");
}

function description(): string {
	return (
		"Have images made: logos and icons (SVG), illustrations, photographic scenes, diagrams with " +
		"labels, or edits of an existing image. Send a brief; an image sub-agent picks the models, " +
		"generates several candidates, critiques them against the brief and refines the best, within " +
		`a budget (default ${DEFAULT_MAX_IMAGES} images, $${DEFAULT_MAX_USD}). ` +
		"Returns the file paths, a contact sheet (HTML, open it in the Files panel) and a short " +
		"summary; the images do not enter your context (use InspectImage to look at one). " +
		"Takes one to several minutes. See the illustration skill for writing a good brief."
	);
}

/** Why the arguments cannot be used, or undefined. */
function argumentProblem(
	a: CreateImageArgs,
	allowedKinds: readonly ImageKind[] | undefined,
): string | undefined {
	const brief = a.brief?.trim();
	if (!brief) return "brief is required";
	if (brief.length > MAX_BRIEF_CHARS) {
		return `brief over ${MAX_BRIEF_CHARS} characters`;
	}
	if (a.kind && allowedKinds && !allowedKinds.includes(a.kind)) {
		return `kind ${a.kind} is not enabled for this mission (enabled: ${allowedKinds.join(", ")})`;
	}
	if ((a.refineJob === undefined) !== (a.refineCandidate === undefined)) {
		return "refineJob and refineCandidate go together";
	}
	return undefined;
}

/** The caller's references and, for a refinement, the parent candidate; validated together. */
async function gatherReferences(
	a: CreateImageArgs,
	opts: Pick<CreateImageToolOptions, "workdir" | "sharedDir">,
	roots: string[],
	render: RenderPreviews | undefined,
): Promise<LabelledReference[]> {
	const references = readCallerReferences(
		roots,
		opts.workdir,
		a.references ?? [],
	);
	if (a.refineJob !== undefined && a.refineCandidate !== undefined) {
		references.push(
			await readParent(opts.sharedDir, a.refineJob, a.refineCandidate, render),
		);
	}
	validateReferences(references);
	return references;
}

/** The job request, with every budget clamped to the platform's limits. */
export function buildRequest(
	a: CreateImageArgs,
	references: LabelledReference[],
): ImageJobRequest {
	return {
		brief: a.brief.trim(),
		options: clamp(a.options, DEFAULT_OPTIONS, 1, MAX_OPTIONS),
		...(a.kind ? { kind: a.kind } : {}),
		...(a.aspectRatio ? { aspectRatio: a.aspectRatio } : {}),
		references,
		...(a.refineJob !== undefined && a.refineCandidate !== undefined
			? { parent: { jobId: a.refineJob, candidate: a.refineCandidate } }
			: {}),
		maxImages: clamp(a.maxImages, DEFAULT_MAX_IMAGES, 1, PLATFORM_MAX_IMAGES),
		maxUsd: clamp(a.maxUsd, DEFAULT_MAX_USD, MIN_USD, PLATFORM_MAX_USD),
	};
}

export function createCreateImageTool(opts: CreateImageToolOptions): MagiTool {
	const render =
		opts.renderPreviews === null
			? undefined
			: (opts.renderPreviews ?? createPreviewRenderer());
	const roots = [opts.workdir, opts.sharedDir];
	return {
		name: "CreateImage",
		description: description(),
		parameters: PARAMS,
		maxRuntimeMs: () => CREATE_IMAGE_MAX_RUNTIME_MS,
		async execute(toolUseId, raw, signal) {
			const a = raw as CreateImageArgs;
			const problem = argumentProblem(a, opts.allowedKinds);
			if (problem) return err(`CreateImage: ${problem}`);
			let req: ImageJobRequest;
			try {
				req = buildRequest(a, await gatherReferences(a, opts, roots, render));
			} catch (e) {
				return err(`CreateImage: ${(e as Error).message}`);
			}
			let outcome: ImageJobOutcome;
			try {
				outcome = await runImageJob(
					{
						agentModel: opts.agentModel,
						sharedDir: opts.sharedDir,
						agentId: opts.agentId,
						...(opts.allowedKinds ? { allowedKinds: opts.allowedKinds } : {}),
						meter: opts.meter,
						beforeLlmCall: opts.beforeLlmCall,
						onSubLoopMessage: opts.onSubLoopMessage
							? (msg) =>
									opts.onSubLoopMessage?.(toolUseId, msg) ?? Promise.resolve()
							: undefined,
						completeFn: opts.completeFn,
						generate: opts.generate,
						renderPreviews: render,
					},
					req,
					signal,
				);
			} catch (e) {
				return err(
					`CreateImage: could not start the job: ${(e as Error).message}`,
				);
			}
			const text = outcomeText(opts.sharedDir, outcome);
			return outcome.manifest.status === "failed"
				? err(text)
				: { content: [{ type: "text", text }] };
		},
	};
}

/** The tool when OpenRouter is configured (image models are served there only). */
export function tryCreateCreateImageTool(
	opts: CreateImageToolOptions,
): MagiTool | undefined {
	if (!process.env.OPENROUTER_API_KEY) return undefined;
	return createCreateImageTool(opts);
}
