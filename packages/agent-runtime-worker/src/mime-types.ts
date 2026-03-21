/**
 * Shared MIME type ↔ file extension mappings used by FetchUrl and InspectImage.
 * A single source of truth — changes here apply to both tools.
 */

/** Map image MIME types to canonical file extensions. */
export const MIME_TO_EXT: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/avif": "avif",
	"image/svg+xml": "svg",
};

/** Map file extensions to image MIME types. */
export const EXT_TO_MIME: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
};

/**
 * MIME types accepted by the Anthropic vision API.
 * SVG and AVIF are excluded — the API does not accept them.
 */
export const VISION_MIMES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
]);
