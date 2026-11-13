/**
 * One image generation through OpenRouter's images endpoint (ADR-0035), over
 * pi-ai's `generateImages`, and the meter event that charges it.
 *
 * Cost: OpenRouter reports its charge in `usage.cost`; MAGI's pi-ai patch
 * surfaces it as `usage.providerCost` for this path as for chat. When no
 * positive charge is reported for a call that returned images, the menu's
 * ceiling price is used and flagged as estimated — an image is never free.
 */

import type {
	AssistantMessage,
	ImageContent,
	ImagesModel,
	ImagesModels,
	Model,
} from "@mariozechner/pi-ai";
import { builtinImagesModels } from "@mariozechner/pi-ai/providers/all";
import type { LlmCallEvent } from "../llm-meter.js";
import { imageMenuEntry } from "./image-models.js";

export const ASPECT_RATIOS = [
	"1:1",
	"16:9",
	"9:16",
	"4:3",
	"3:4",
	"3:2",
	"2:3",
] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/** At most this many reference images per call, each at most this size (decoded). */
export const MAX_REFERENCE_IMAGES = 3;
export const MAX_REFERENCE_BYTES = 5 * 1024 * 1024;
/** A generated image larger than this is refused (a 16:9 FLUX image measured 3.8 MB). */
export const MAX_GENERATED_BYTES = 12 * 1024 * 1024;
export const DEFAULT_IMAGE_TIMEOUT_MS = 120_000;

const REFERENCE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const OUTPUT_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/svg+xml",
]);

export interface ImageReference {
	mimeType: string;
	/** Base64, without a data: prefix. */
	data: string;
}

export interface GenerateImageRequest {
	modelId: string;
	prompt: string;
	references?: ImageReference[];
	aspectRatio?: AspectRatio;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface GeneratedImage {
	mimeType: string;
	bytes: Buffer;
}

export interface GenerateImageResult {
	modelId: string;
	images: GeneratedImage[];
	/** Any text the model returned alongside the images. */
	text?: string;
	costUsd: number;
	/** True when the cost is the menu's ceiling price, not OpenRouter's reported charge. */
	costEstimated: boolean;
	responseId?: string;
	tokens: { input: number; output: number };
}

export type GenerateImagesFn = ImagesModels["generateImages"];

let defaultImagesModels: ImagesModels | undefined;
/** pi-ai's image collection with its built-in providers (OpenRouter's reads OPENROUTER_API_KEY). */
function imagesModels(): ImagesModels {
	defaultImagesModels ??= builtinImagesModels();
	return defaultImagesModels;
}

function decodedSize(base64: string): number {
	return Math.floor((base64.length * 3) / 4);
}

export function validateReferences(refs: ImageReference[] = []): void {
	if (refs.length > MAX_REFERENCE_IMAGES) {
		throw new Error(
			`At most ${MAX_REFERENCE_IMAGES} reference images per call (got ${refs.length})`,
		);
	}
	for (const r of refs) {
		if (!REFERENCE_TYPES.has(r.mimeType)) {
			throw new Error(
				`Reference image type ${r.mimeType} is not accepted (PNG, JPEG or WebP)`,
			);
		}
		if (decodedSize(r.data) > MAX_REFERENCE_BYTES) {
			throw new Error(
				`Reference image too large (limit ${MAX_REFERENCE_BYTES / 1024 / 1024} MB)`,
			);
		}
	}
}

/**
 * Generate images with a menu model. Throws on a model outside the menu, an
 * invalid reference, a provider error, or an oversized or unexpected output.
 */
export async function generateImage(
	req: GenerateImageRequest,
	deps: {
		getModel?: (id: string) => ImagesModel<string> | undefined;
		generate?: GenerateImagesFn;
	} = {},
): Promise<GenerateImageResult> {
	const entry = imageMenuEntry(req.modelId);
	if (!entry)
		throw new Error(`Image model ${req.modelId} is not in the image menu`);
	validateReferences(req.references);
	const model = (
		deps.getModel ?? ((id: string) => imagesModels().getModel("openrouter", id))
	)(req.modelId);
	if (!model) {
		throw new Error(
			`Image model ${req.modelId} is not in pi-ai's image registry`,
		);
	}
	const generate: GenerateImagesFn =
		deps.generate ?? ((m, c, o) => imagesModels().generateImages(m, c, o));

	const input: Array<{ type: "text"; text: string } | ImageContent> = [
		{ type: "text", text: req.prompt },
		...(req.references ?? []).map(
			(r): ImageContent => ({
				type: "image",
				mimeType: r.mimeType,
				data: r.data,
			}),
		),
	];
	const timeout = AbortSignal.timeout(
		req.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS,
	);
	const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
	const response = await generate(
		model,
		{ input },
		{
			signal,
			onPayload: (payload) => ({
				...(payload as Record<string, unknown>),
				usage: { include: true },
				...(req.aspectRatio
					? { image_config: { aspect_ratio: req.aspectRatio } }
					: {}),
			}),
		},
	);
	if (response.stopReason !== "stop") {
		throw new Error(
			`Image generation with ${req.modelId} ${response.stopReason}: ${response.errorMessage ?? "no detail"}`,
		);
	}

	const { images, text } = collectOutput(req.modelId, response.output);
	return {
		modelId: req.modelId,
		images,
		...(text ? { text } : {}),
		...chargeFor(
			response.usage?.providerCost,
			entry.ceilingUsdPerImage,
			images.length,
		),
		...(response.responseId ? { responseId: response.responseId } : {}),
		tokens: {
			input: response.usage?.input ?? 0,
			output: response.usage?.output ?? 0,
		},
	};
}

/** The images and text of a response; refuses unexpected types, oversized images and an empty result. */
export function collectOutput(
	modelId: string,
	output: ReadonlyArray<{ type: "text"; text: string } | ImageContent>,
): { images: GeneratedImage[]; text?: string } {
	const images: GeneratedImage[] = [];
	const texts: string[] = [];
	for (const block of output) {
		if (block.type === "text") {
			texts.push(block.text);
			continue;
		}
		if (!OUTPUT_TYPES.has(block.mimeType)) {
			throw new Error(
				`${modelId} returned an unexpected image type ${block.mimeType}`,
			);
		}
		if (decodedSize(block.data) > MAX_GENERATED_BYTES) {
			throw new Error(
				`${modelId} returned an image over ${MAX_GENERATED_BYTES / 1024 / 1024} MB`,
			);
		}
		images.push({
			mimeType: block.mimeType,
			bytes: Buffer.from(block.data, "base64"),
		});
	}
	const text = texts.length ? texts.join("\n") : undefined;
	if (images.length === 0) {
		throw new Error(
			`${modelId} returned no image${text ? `: ${text.slice(0, 200)}` : ""}`,
		);
	}
	return { images, ...(text ? { text } : {}) };
}

/** OpenRouter's charge when it reported a positive one, else the ceiling price per image, flagged. */
export function chargeFor(
	reported: number | undefined,
	ceilingUsdPerImage: number,
	imageCount: number,
): { costUsd: number; costEstimated: boolean } {
	if (
		typeof reported === "number" &&
		Number.isFinite(reported) &&
		reported > 0
	) {
		return { costUsd: reported, costEstimated: false };
	}
	return { costUsd: ceilingUsdPerImage * imageCount, costEstimated: true };
}

/** The meter event for a generation: charged at its fixed cost, with the prompt but no image bytes. */
export function imageMeterEvent(
	result: GenerateImageResult,
	prompt: string,
): LlmCallEvent {
	const usage = {
		input: result.tokens.input,
		output: result.tokens.output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: result.tokens.input + result.tokens.output,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: result.costUsd,
		},
	};
	const response: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "text",
				text: `[generated ${result.images.length} image(s): ${result.images.map((i) => i.mimeType).join(", ")}]`,
			},
		],
		api: "openrouter-images",
		provider: "openrouter",
		model: result.modelId,
		...(result.responseId ? { responseId: result.responseId } : {}),
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
	// Token prices are irrelevant here: fixedCost carries the charge.
	const model = {
		id: result.modelId,
		name: result.modelId,
		api: "openrouter-images",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 0,
		maxTokens: 0,
	} as Model<string>;
	return {
		systemPrompt: "",
		messages: [
			{ role: "user", content: [{ type: "text", text: prompt }], timestamp: 0 },
		],
		toolNames: [],
		response,
		model,
		fixedCost: { totalUsd: result.costUsd, estimated: result.costEstimated },
	};
}
