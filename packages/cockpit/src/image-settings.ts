/**
 * The mission's image-generation settings in the config editors (ADR-0035):
 * the image sub-agent's model and the kinds of image job the mission
 * allows. The menu itself (models, tiers, ceiling prices) comes from the
 * server's catalog; nothing here is hard-coded but the kind labels.
 *
 * `imageKinds: null` means no restriction (every kind). Ticking every kind,
 * or none, saves as no restriction: switching image generation off is done
 * per agent, by disabling the CreateImage tool.
 */

export interface ImageMenuItem {
	id: string;
	kind: string;
	tiers: string[];
	output: "svg" | "raster";
	ceilingUsdPerImage: number;
	strengths: string;
}

export interface ImageSettingsDraft {
	imageAgentModel: string;
	imageKinds: string[] | null;
}

const KIND_LABELS: Record<string, string> = {
	vector: "Logos and icons (SVG)",
	"raster-art": "Illustrations and photographic images",
	"raster-instruct": "Diagrams with text, edits by instruction",
};

export function kindLabel(kind: string): string {
	return KIND_LABELS[kind] ?? kind;
}

/** The kinds on the menu, in menu order. */
export function menuKinds(menu: readonly ImageMenuItem[]): string[] {
	return [...new Set(menu.map((m) => m.kind))];
}

export function menuLine(item: ImageMenuItem): string {
	return `${item.id} — ${item.tiers.join("/")}, ${item.output.toUpperCase()}, at most $${item.ceilingUsdPerImage.toFixed(2)} per image`;
}

/** The editor's draft from a stored mission. */
export function imageSettingsOf(mission: {
	imageAgentModel?: unknown;
	imageModels?: unknown;
}): ImageSettingsDraft {
	const stored = Array.isArray(mission.imageModels)
		? mission.imageModels.filter((k): k is string => typeof k === "string")
		: null;
	return {
		imageAgentModel:
			typeof mission.imageAgentModel === "string"
				? mission.imageAgentModel
				: "",
		imageKinds: stored && stored.length > 0 ? stored : null,
	};
}

export function isKindEnabled(kinds: string[] | null, kind: string): boolean {
	return kinds === null || kinds.includes(kind);
}

/** The selection after ticking or unticking one kind. */
export function toggleKind(
	kinds: string[] | null,
	kind: string,
	allKinds: readonly string[],
): string[] {
	const current = kinds ?? [...allKinds];
	return current.includes(kind)
		? current.filter((k) => k !== kind)
		: allKinds.filter((k) => k === kind || current.includes(k));
}

/** A note when the selection will not save as typed, else undefined. */
export function kindsNote(
	kinds: string[] | null,
	allKinds: readonly string[],
): string | undefined {
	if (kinds !== null && kinds.length === 0 && allKinds.length > 0) {
		return "No kind ticked: every kind stays enabled. To turn image generation off, disable the CreateImage tool for the agents.";
	}
	return undefined;
}

/** The two mission fields to save; an absent field clears the stored value. */
export function imageFieldsForSave(
	d: ImageSettingsDraft,
	allKinds: readonly string[],
): { imageAgentModel?: string; imageModels?: string[] } {
	const model = d.imageAgentModel.trim();
	const kinds = d.imageKinds;
	if (kinds !== null && kinds.length > 0 && allKinds.length === 0) {
		// The menu did not load: keep the stored restriction as it is.
		return {
			...(model ? { imageAgentModel: model } : {}),
			imageModels: kinds,
		};
	}
	const restricted =
		kinds !== null &&
		kinds.length > 0 &&
		allKinds.some((k) => !kinds.includes(k));
	return {
		...(model ? { imageAgentModel: model } : {}),
		...(restricted
			? { imageModels: allKinds.filter((k) => kinds.includes(k)) }
			: {}),
	};
}
