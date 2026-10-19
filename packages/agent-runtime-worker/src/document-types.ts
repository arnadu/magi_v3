/** Document processing's shared types and limits. */

import type { FileEntry } from "./artifacts.js";
import type { DescribeImageFn, OcrPageFn } from "./document-vision.js";

// ---------------------------------------------------------------------------
// Types + limits
// ---------------------------------------------------------------------------

export type DocFormat =
	| "text"
	| "csv"
	| "image"
	| "pdf"
	| "xlsx"
	| "docx"
	| "zip"
	| "unknown";

export type ProcessingStatus = "complete" | "partial" | "unsupported";

/** One item the describe-now/defer policy ranks. `width`/`height` omitted ⇒ always substantive (e.g. full-page renders). */
export interface RankableImage {
	index: number;
	width?: number;
	height?: number;
}

export interface ImageSelection {
	/** Indices to auto-describe now (largest-area first, within budget). */
	describe: number[];
	/** Substantive but over the per-document budget — defer to InspectImage. */
	deferred: number[];
	/** Sub-threshold (icons/spacers/dividers) — omit from inline narration. */
	decorative: number[];
}

export interface ProcessLimits {
	/** An image is substantive only if both dimensions ≥ this (px). */
	minImageDim: number;
	/** …and its aspect ratio ≤ this (drops banners / rules). */
	maxImageAspect: number;
	/** Auto-describe at most this many images/page-renders per document. */
	maxAutoDescribe: number;
	/** Render at most this many PDF pages to PNG (CPU/disk bound). Text is unbounded. */
	maxRenderPages: number;
	/** Rows shown in the content.md preview for CSV/sheets (full data saved separately). */
	previewRows: number;
	/** Process at most this many files inside a ZIP; the rest are listed as unprocessed. */
	maxZipFiles: number;
	/** Skip a ZIP entry whose declared uncompressed size exceeds this (bytes). */
	maxZipEntryBytes: number;
	/** Stop expanding a ZIP once this many uncompressed bytes have been inflated. */
	maxZipTotalBytes: number;
	/**
	 * Extract text from at most this many PDF pages. mupdf runs synchronously
	 * on the daemon thread, so an unbounded loop over a hostile or huge web
	 * PDF stalls every agent's tool calls; pages past the limit are listed as
	 * unprocessed and the raw PDF is kept.
	 */
	maxTextPages: number;
}

export const DEFAULT_LIMITS: ProcessLimits = {
	minImageDim: 200,
	maxImageAspect: 8,
	maxAutoDescribe: 10,
	maxRenderPages: 50,
	previewRows: 5,
	maxZipFiles: 20,
	maxZipEntryBytes: 25 * 1024 * 1024,
	maxZipTotalBytes: 100 * 1024 * 1024,
	maxTextPages: 300,
};

/** Appended wherever model-generated text (OCR, descriptions) enters content.md: it is derived from an untrusted document, not from the platform. */

export interface ProcessOptions {
	filename: string;
	mimeType?: string;
	/** Directory under which `artifacts/{id}/` is written. */
	artifactsDir: string;
	describeImage?: DescribeImageFn;
	/** Describer for a PDF page's "Page visual" note specifically — a different,
	 * description-only prompt from `describeImage` (see PAGE_VISUAL_PROMPT). Not
	 * used for scanned pages (those go through `ocrPage`) or for standalone/
	 * DOCX-embedded images (those use `describeImage`). */
	describePageVisual?: DescribeImageFn;
	/** OCR fallback for scanned PDF pages with no embedded text layer (issue #50). */
	ocrPage?: OcrPageFn;
	limits?: Partial<ProcessLimits>;
	signal?: AbortSignal;
	/** How many ZIPs enclose this buffer; an archive found inside an archive is never expanded. */
	zipDepth?: number;
	/**
	 * Source URL when the bytes came from the web (FetchUrl). Recorded as
	 * `meta.url` and used for the artifact-id slug, preserving provenance.
	 */
	sourceUrl?: string;
}

export interface ProcessResult {
	artifactId: string;
	format: DocFormat;
	processingStatus: ProcessingStatus;
	/** Absolute path to the artifact's content.md. */
	contentPath: string;
	/** One-line summary suitable for the upload mailbox message. */
	summary: string;
	/** What was not processed and why — the reason `processingStatus` is "partial". */
	unprocessed?: { item: string; reason: string }[];
}

export interface Handled {
	format: DocFormat;
	status: ProcessingStatus;
	files: FileEntry[];
	/** Items deferred / unsupported, recorded in meta.json. */
	unprocessed?: { item: string; reason: string }[];
	summary: string;
}
