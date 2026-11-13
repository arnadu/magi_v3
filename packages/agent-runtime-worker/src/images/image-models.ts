/**
 * The image-generation model menu (ADR-0035): which OpenRouter image model
 * serves which kind of job, at which tier, and the most an image may cost.
 *
 * The menu is code: it changes by a commit, never by an agent. A mission may
 * only narrow it to some kinds (`mission.imageModels`). Every entry carries a
 * ceiling price, used when a provider response reports no charge, so an image
 * is never recorded as free: pi-ai's own registry prices most per-image models
 * at $0 (measured prices and the reasoning: ADR-0035, the 2026-11-13 spike).
 */

import type { ImageKind } from "@magi/agent-config";

export { IMAGE_KINDS, type ImageKind } from "@magi/agent-config";

export const IMAGE_TIERS = ["draft", "final"] as const;
export type ImageTier = (typeof IMAGE_TIERS)[number];

export interface ImageMenuEntry {
	/** OpenRouter model id, as in pi-ai's image model registry. */
	id: string;
	kind: ImageKind;
	tiers: readonly ImageTier[];
	/** What the model returns. */
	output: "svg" | "raster";
	/** Charged per image at most, in USD: the fallback when no charge is reported. */
	ceilingUsdPerImage: number;
	/** One line for the sub-agent's prompt: what this model is good at. */
	strengths: string;
}

export const IMAGE_MENU: readonly ImageMenuEntry[] = [
	{
		id: "recraft/recraft-v4.1-vector",
		kind: "vector",
		tiers: ["draft"],
		output: "svg",
		ceilingUsdPerImage: 0.16,
		strengths: "logos, icons and marks as clean SVG; lettering drawn as shapes",
	},
	{
		id: "recraft/recraft-v4.1-pro-vector",
		kind: "vector",
		tiers: ["final"],
		output: "svg",
		ceilingUsdPerImage: 0.6,
		strengths: "the most refined SVG logos and marks",
	},
	{
		id: "black-forest-labs/flux.2-pro",
		kind: "raster-art",
		tiers: ["draft", "final"],
		output: "raster",
		ceilingUsdPerImage: 0.2,
		strengths:
			"illustrations, photoreal scenes, art styles and raster logos; needs a descriptive prompt",
	},
	{
		id: "google/gemini-3.1-flash-lite-image",
		kind: "raster-instruct",
		tiers: ["draft"],
		output: "raster",
		ceilingUsdPerImage: 0.08,
		strengths:
			"quick drafts, edits by instruction on a reference image, diagrams; ask for an isolated asset or it may return a mock-up",
	},
	{
		id: "google/gemini-3-pro-image",
		kind: "raster-instruct",
		tiers: ["final"],
		output: "raster",
		ceilingUsdPerImage: 0.3,
		strengths:
			"complex instructions, layouts and diagrams with legible text, precise edits",
	},
];

export function imageMenuEntry(id: string): ImageMenuEntry | undefined {
	return IMAGE_MENU.find((e) => e.id === id);
}

/**
 * The menu entry for a kind of job at a tier, within the kinds a mission
 * allows (all kinds when it sets none). Throws when the kind is not allowed.
 */
export function resolveImageModel(
	kind: ImageKind,
	tier: ImageTier,
	allowedKinds?: readonly ImageKind[],
): ImageMenuEntry {
	if (allowedKinds && !allowedKinds.includes(kind)) {
		throw new Error(
			`Image kind "${kind}" is not enabled for this mission (allowed: ${allowedKinds.join(", ") || "none"})`,
		);
	}
	const entry = IMAGE_MENU.find(
		(e) => e.kind === kind && e.tiers.includes(tier),
	);
	if (!entry) {
		throw new Error(`No image model for kind "${kind}" at tier "${tier}"`);
	}
	return entry;
}
