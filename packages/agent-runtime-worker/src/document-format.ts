/** Format detection, the describe-now/defer image policy, and the status/hint text every handler writes. */

import { imageSize } from "image-size";
import type * as mupdf from "mupdf";
import type {
	DocFormat,
	Handled,
	ImageSelection,
	ProcessingStatus,
	ProcessLimits,
	RankableImage,
} from "./document-types.js";

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

export const PDF_SCALE = 1.5; // ≈108 DPI — good enough for vision, modest file size

/** A page's extracted text shorter than this is treated as scanned (no text layer) — issue #50. */
export const SCANNED_TEXT_THRESHOLD = 50;

/** Magic-byte sniff for the formats we route on. Cheap, no dependency. */
export function sniff(bytes: Buffer): DocFormat | undefined {
	if (bytes.length >= 5 && bytes.toString("latin1", 0, 5) === "%PDF-") {
		return "pdf";
	}
	if (bytes.length >= 8 && bytes.toString("hex", 0, 8) === "89504e470d0a1a0a") {
		return "image"; // PNG
	}
	if (bytes.length >= 3 && bytes.toString("hex", 0, 3) === "ffd8ff") {
		return "image"; // JPEG
	}
	if (bytes.length >= 6 && bytes.toString("latin1", 0, 6).startsWith("GIF8")) {
		return "image"; // GIF
	}
	// ZIP container — also the envelope for XLSX/DOCX; caller refines by extension.
	if (bytes.length >= 4 && bytes.toString("hex", 0, 4) === "504b0304") {
		return "zip";
	}
	return undefined;
}

export const EXT_FORMAT: Record<string, DocFormat> = {
	txt: "text",
	md: "text",
	markdown: "text",
	csv: "csv",
	tsv: "csv",
	pdf: "pdf",
	jpg: "image",
	jpeg: "image",
	png: "image",
	gif: "image",
	webp: "image",
	avif: "image",
	xlsx: "xlsx",
	xlsm: "xlsx",
	docx: "docx",
	zip: "zip",
};

/**
 * Decide the format from (in priority order) the extension, then a magic-byte
 * sniff, then the supplied MIME type. Extension wins first because the
 * ZIP-container formats (xlsx/docx) sniff as "zip" — the extension disambiguates.
 */
export function detectFormat(
	filename: string,
	mimeType: string | undefined,
	bytes: Buffer,
): DocFormat {
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	if (EXT_FORMAT[ext]) return EXT_FORMAT[ext];

	const sniffed = sniff(bytes);
	if (sniffed) return sniffed;

	const mime = (mimeType ?? "").split(";")[0].trim().toLowerCase();
	if (mime.startsWith("image/")) return "image";
	if (mime === "application/pdf") return "pdf";
	if (mime === "text/csv") return "csv";
	if (mime.startsWith("text/")) return "text";
	return "unknown";
}

// ---------------------------------------------------------------------------
// Image describe-now / defer policy (pure)
// ---------------------------------------------------------------------------

/**
 * Partition images into describe-now / deferred / decorative per the agreed
 * policy: drop sub-threshold (decorative) images, then auto-describe the
 * largest `maxAutoDescribe` of the rest; defer the remainder. Items without
 * dimensions (e.g. full-page renders) are always substantive. Pure — the heart
 * of the cost control, unit-tested independently of any document parsing.
 */
export function selectImages(
	images: RankableImage[],
	limits: ProcessLimits,
): ImageSelection {
	const decorative: number[] = [];
	const substantive: RankableImage[] = [];

	for (const img of images) {
		const hasDims = img.width !== undefined && img.height !== undefined;
		if (hasDims) {
			const w = img.width as number;
			const h = img.height as number;
			const minDim = Math.min(w, h);
			const aspect = Math.max(w, h) / Math.max(1, Math.min(w, h));
			if (minDim < limits.minImageDim || aspect > limits.maxImageAspect) {
				decorative.push(img.index);
				continue;
			}
		}
		substantive.push(img);
	}

	// Largest-area first; dimensionless items (pages) sort as +∞ so they keep
	// document order ahead of sized images — pages are always content.
	const area = (i: RankableImage) =>
		i.width !== undefined && i.height !== undefined
			? i.width * i.height
			: Number.POSITIVE_INFINITY;
	substantive.sort((a, b) => area(b) - area(a));

	const describe = substantive
		.slice(0, limits.maxAutoDescribe)
		.map((i) => i.index);
	const deferred = substantive
		.slice(limits.maxAutoDescribe)
		.map((i) => i.index);
	return { describe, deferred, decorative };
}

// ---------------------------------------------------------------------------
// content.md status line
// ---------------------------------------------------------------------------

export function statusLine(status: ProcessingStatus, detail?: string): string {
	switch (status) {
		case "complete":
			return "✓ Fully processed.";
		case "partial":
			return `⚠ Partially processed.${detail ? ` ${detail}` : ""}`;
		case "unsupported":
			return `✗ Format not supported.${detail ? ` ${detail}` : ""}`;
	}
}

/**
 * Absolute-path hint for an `InspectImage("<path>")` call embedded in
 * generated content.md text (issue #51). InspectImage resolves a relative
 * path against the agent's `workdir`, not `sharedDir` — where every artifact
 * actually lives — so a bare `artifacts/<id>/...` hint silently fails to
 * resolve. Unlike a Bash `cat` hint, `$SHARED_DIR` doesn't help here either:
 * InspectImage is a direct tool call, not a shell command, so nothing
 * expands `$SHARED_DIR` in its `path` argument — it needs a real absolute
 * path, matching the convention the tool's own description already uses.
 * The artifact id itself is still a literal `<id>` placeholder: it isn't
 * assigned until after these handlers return (see processBuffer).
 */
export function inspectImageHint(
	artifactsDir: string,
	relPath: string,
): string {
	return `${artifactsDir}/artifacts/<id>/${relPath}`;
}

/**
 * Whether a page has any embedded graphical content (an Image or Form
 * XObject) at all — used to skip an unnecessary describePageVisual vision
 * call on a page that is provably pure text.
 *
 * mupdf's text extraction does NOT report non-text visual content as an
 * "image" the way one might expect: verified live against a real PDF whose
 * visible logo turned out to be a Form XObject (a self-contained nested
 * content stream — common for vector-drawn graphics), not an Image XObject.
 * `StructuredText.asJSON()` reported zero "image"-type blocks for that page
 * even with the `"preserve-images"` option, because the logo was never in a
 * shape that mode surfaces at all. This checks the page's own
 * Resources/XObject dictionary directly instead of inferring from text
 * extraction, which structurally cannot see this content.
 */
export function pageHasVisualContent(page: mupdf.Page): boolean {
	if (!page.isPDF()) return true; // not a page shape we can inspect this way — err toward describing it
	const resources = (page as mupdf.PDFPage)
		.getObject()
		.getInheritable("Resources");
	const xobjects = resources.get("XObject");
	if (!xobjects || xobjects.isNull()) return false;
	let found = false;
	xobjects.forEach(() => {
		found = true;
	});
	return found;
}

/** Read image dimensions from a buffer, or undefined if unparseable. */
export function imageDims(
	bytes: Buffer,
): { width: number; height: number } | undefined {
	try {
		const d = imageSize(bytes);
		if (typeof d.width === "number" && typeof d.height === "number") {
			return { width: d.width, height: d.height };
		}
	} catch {
		// unparseable — treat as dimensionless (substantive)
	}
	return undefined;
}

export function processUnsupported(
	bytes: Buffer,
	filename: string,
	detail?: string,
): Handled {
	return {
		format: "unknown",
		status: "unsupported",
		files: [
			{
				name: "content.md",
				content: statusLine(
					"unsupported",
					detail ??
						`Unrecognized format for "${filename}". Raw file saved alongside — open it with Bash if it is text-like.`,
				),
			},
			{ name: filename, content: bytes },
		],
		summary: "unsupported file",
	};
}
