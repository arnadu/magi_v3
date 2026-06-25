/**
 * Shared document processor — Sprint 25 phase 2.
 *
 * Turns an uploaded file (raw bytes + filename) into an LLM-readable artifact:
 * a `content.md` plus extracted assets (page renders, the raw data file) under
 * `{artifactsDir}/artifacts/{id}/`, with a `meta.json` partial-processing marker.
 *
 * Design notes (see the Sprint 25 plan):
 *   - **No text truncation.** All text from every page/row is preserved; agents
 *     read slices with Bash. Only the expensive VISION step is budgeted.
 *   - **Image describe-now vs defer.** Auto-describing every image in a large
 *     document is slow and costly, so each image is either described now (up to a
 *     per-document budget, largest first) or deferred with an `InspectImage(path,
 *     question)` pointer in the markdown — the agent processes it on demand. There
 *     is no new tool: deferral rides on the existing InspectImage.
 *   - **Partial-processing is first-class.** `meta.json.processingStatus` is
 *     `complete | partial | unsupported`, and `content.md` opens with a visible
 *     status line so the agent knows what is and isn't narrated.
 *
 * The vision call is injected as `describeImage` so this module has no LLM
 * dependency and is fully unit-testable; production wires it to the vision model.
 *
 * This slice handles: plain text / Markdown, CSV, single images, and PDF.
 * XLSX / DOCX / ZIP and the dimension-based filter for embedded images land in
 * the next slice (they need exceljs / mammoth / jszip / image-size).
 */

import { join } from "node:path";
import * as mupdf from "mupdf";
import {
	type ArtifactMeta,
	type FileEntry,
	generateArtifactId,
	saveArtifact,
} from "./artifacts.js";
import { MIME_TO_EXT } from "./mime-types.js";

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
}

export const DEFAULT_LIMITS: ProcessLimits = {
	minImageDim: 200,
	maxImageAspect: 8,
	maxAutoDescribe: 10,
	maxRenderPages: 50,
	previewRows: 5,
};

/** Injected vision call. Returns a short description, or undefined on failure / no capability. */
export type DescribeImageFn = (
	bytes: Buffer,
	mimeType: string,
) => Promise<string | undefined>;

export interface ProcessOptions {
	filename: string;
	mimeType?: string;
	/** Directory under which `artifacts/{id}/` is written. */
	artifactsDir: string;
	describeImage?: DescribeImageFn;
	limits?: Partial<ProcessLimits>;
	signal?: AbortSignal;
}

export interface ProcessResult {
	artifactId: string;
	format: DocFormat;
	processingStatus: ProcessingStatus;
	/** Absolute path to the artifact's content.md. */
	contentPath: string;
	/** One-line summary suitable for the upload mailbox message. */
	summary: string;
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

const PDF_SCALE = 1.5; // ≈108 DPI — good enough for vision, modest file size

/** Magic-byte sniff for the formats we route on. Cheap, no dependency. */
function sniff(bytes: Buffer): DocFormat | undefined {
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

const EXT_FORMAT: Record<string, DocFormat> = {
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

function statusLine(status: ProcessingStatus, detail?: string): string {
	switch (status) {
		case "complete":
			return "✓ Fully processed.";
		case "partial":
			return `⚠ Partially processed.${detail ? ` ${detail}` : ""}`;
		case "unsupported":
			return `✗ Format not supported.${detail ? ` ${detail}` : ""}`;
	}
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

interface Handled {
	format: DocFormat;
	status: ProcessingStatus;
	files: FileEntry[];
	/** Items deferred / unsupported, recorded in meta.json. */
	unprocessed?: { item: string; reason: string }[];
	summary: string;
}

function processText(bytes: Buffer, filename: string): Handled {
	const text = bytes.toString("utf8");
	const content = `${statusLine("complete")}\n\n# ${filename}\n\n${text}`;
	return {
		format: "text",
		status: "complete",
		files: [{ name: "content.md", content }],
		summary: `text file (${text.length} chars)`,
	};
}

function processCsv(
	bytes: Buffer,
	filename: string,
	limits: ProcessLimits,
): Handled {
	const raw = bytes.toString("utf8");
	const lines = raw.split(/\r?\n/);
	const nonEmpty = lines.filter((l) => l.trim().length > 0);
	const header = nonEmpty[0] ?? "";
	const dataRows = Math.max(0, nonEmpty.length - 1);
	const preview = nonEmpty.slice(0, limits.previewRows + 1).join("\n");
	// Full data is preserved verbatim as a sibling file for Bash slicing.
	const content = [
		statusLine("complete"),
		"",
		`# ${filename}`,
		"",
		`Columns: \`${header}\``,
		`Rows: ${dataRows} (full data in \`data.csv\` — read slices with Bash, e.g. \`sed -n '2,50p' data.csv\`)`,
		"",
		`## Preview (first ${Math.min(limits.previewRows, dataRows)} rows)`,
		"",
		"```",
		preview,
		"```",
	].join("\n");
	return {
		format: "csv",
		status: "complete",
		files: [
			{ name: "content.md", content },
			{ name: "data.csv", content: raw },
		],
		summary: `CSV (${dataRows} rows)`,
	};
}

async function processImage(
	bytes: Buffer,
	filename: string,
	mimeType: string,
	describeImage: DescribeImageFn | undefined,
): Promise<Handled> {
	const cleanMime = mimeType.split(";")[0].trim() || "image/jpeg";
	const ext = MIME_TO_EXT[cleanMime] ?? filename.split(".").pop() ?? "jpg";
	const imageName = `image.${ext}`;
	const description = describeImage
		? await describeImage(bytes, cleanMime)
		: undefined;
	const body = description
		? `${description}`
		: `(Not described automatically — InspectImage("artifacts/<id>/${imageName}", "your question") to analyze.)`;
	const content = `${statusLine("complete")}\n\n# ${filename}\n\n${body}`;
	return {
		format: "image",
		status: "complete",
		files: [
			{ name: "content.md", content },
			{ name: imageName, content: bytes },
		],
		summary: description ? "image (described)" : "image",
	};
}

async function processPdf(
	bytes: Buffer,
	filename: string,
	limits: ProcessLimits,
	describeImage: DescribeImageFn | undefined,
	signal?: AbortSignal,
): Promise<Handled> {
	let doc: mupdf.Document;
	try {
		doc = mupdf.Document.openDocument(bytes, "application/pdf");
	} catch (e) {
		return {
			format: "pdf",
			status: "unsupported",
			files: [
				{
					name: "content.md",
					content: `${statusLine("unsupported", `Could not open PDF — ${(e as Error).message}. Raw file saved as ${filename}.`)}`,
				},
				{ name: filename, content: bytes },
			],
			summary: "PDF (unreadable)",
		};
	}

	const pageCount = doc.countPages();
	const renderCount = Math.min(pageCount, limits.maxRenderPages);

	// Page renders are full-page → all substantive; the budget caps how many we
	// describe (dimensionless items keep document order via selectImages).
	const renderItems: RankableImage[] = Array.from(
		{ length: renderCount },
		(_, i) => ({ index: i }),
	);
	const selection = selectImages(renderItems, limits);
	const describeSet = new Set(selection.describe);

	const matrix: [number, number, number, number, number, number] = [
		PDF_SCALE,
		0,
		0,
		PDF_SCALE,
		0,
		0,
	];

	const files: FileEntry[] = [];
	const sections: string[] = [];
	const unprocessed: { item: string; reason: string }[] = [];

	for (let i = 0; i < pageCount; i++) {
		if (signal?.aborted) break;
		const page = doc.loadPage(i);
		const text = page.toStructuredText().asText().trim();
		let section = `## Page ${i + 1}`;
		if (text) section += `\n\n${text}`;

		if (i < renderCount) {
			const fileName = `page-${i + 1}.png`;
			try {
				const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);
				const png = Buffer.from(pixmap.asPNG());
				files.push({ name: fileName, content: png });

				if (describeSet.has(i) && describeImage) {
					const desc = await describeImage(png, "image/png");
					if (desc) {
						section += `\n\n**Page visual:** ${desc}`;
					} else {
						section += `\n\n*(Page ${i + 1} visual: InspectImage("artifacts/<id>/${fileName}") to analyze.)*`;
					}
				} else {
					section += `\n\n*(Page ${i + 1} rendered but not auto-described — InspectImage("artifacts/<id>/${fileName}", "your question") to analyze.)*`;
					unprocessed.push({ item: fileName, reason: "over-budget" });
				}
			} catch {
				section += `\n\n*(Page ${i + 1} render failed — text only.)*`;
			}
		} else {
			section += `\n\n*(Page ${i + 1} not rendered — beyond the ${limits.maxRenderPages}-page render limit; text above is complete. Raw PDF saved as ${filename}.)*`;
			unprocessed.push({
				item: `page-${i + 1}`,
				reason: "beyond-render-limit",
			});
		}
		sections.push(section);
	}

	// Keep the source PDF so deferred pages remain fully recoverable.
	files.push({ name: filename, content: bytes });

	const status: ProcessingStatus =
		unprocessed.length > 0 ? "partial" : "complete";
	const detail =
		status === "partial"
			? `Text for all ${pageCount} pages is included. ${selection.deferred.length} rendered page(s) await InspectImage; ${pageCount - renderCount} page(s) beyond the render limit.`
			: undefined;
	const content = [
		statusLine(status, detail),
		"",
		`# ${filename} (${pageCount} page${pageCount === 1 ? "" : "s"})`,
		"",
		sections.join("\n\n---\n\n") || "(No text extracted.)",
	].join("\n");

	files.unshift({ name: "content.md", content });
	return {
		format: "pdf",
		status,
		files,
		unprocessed: unprocessed.length > 0 ? unprocessed : undefined,
		summary: `PDF (${pageCount} pages${status === "partial" ? ", partial" : ""})`,
	};
}

function processUnsupported(bytes: Buffer, filename: string): Handled {
	return {
		format: "unknown",
		status: "unsupported",
		files: [
			{
				name: "content.md",
				content: statusLine(
					"unsupported",
					`Unrecognized format for "${filename}". Raw file saved alongside — open it with Bash if it is text-like.`,
				),
			},
			{ name: filename, content: bytes },
		],
		summary: "unsupported file",
	};
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Process a file buffer into an artifact directory. Returns where the
 * `content.md` landed and a one-line summary for the upload mailbox message.
 */
export async function processBuffer(
	bytes: Buffer,
	opts: ProcessOptions,
): Promise<ProcessResult> {
	const limits = { ...DEFAULT_LIMITS, ...opts.limits };
	const format = detectFormat(opts.filename, opts.mimeType, bytes);
	const mime = opts.mimeType ?? "application/octet-stream";

	let handled: Handled;
	switch (format) {
		case "text":
			handled = processText(bytes, opts.filename);
			break;
		case "csv":
			handled = processCsv(bytes, opts.filename, limits);
			break;
		case "image":
			handled = await processImage(
				bytes,
				opts.filename,
				mime,
				opts.describeImage,
			);
			break;
		case "pdf":
			handled = await processPdf(
				bytes,
				opts.filename,
				limits,
				opts.describeImage,
				opts.signal,
			);
			break;
		default:
			// xlsx / docx / zip land in the next slice; until then they fall through
			// to the raw-file handler so nothing is lost.
			handled = processUnsupported(bytes, opts.filename);
	}

	const artifactId = generateArtifactId(opts.filename);
	const meta: ArtifactMeta = {
		"@type": "DigitalDocument",
		id: artifactId,
		name: opts.filename,
		dateCreated: new Date().toISOString(),
		encodingFormat: mime,
		processingStatus: handled.status,
		...(handled.unprocessed ? { unprocessed: handled.unprocessed } : {}),
	};

	const dir = await saveArtifact(
		opts.artifactsDir,
		artifactId,
		handled.files,
		meta,
	);
	return {
		artifactId,
		format: handled.format,
		processingStatus: handled.status,
		contentPath: join(dir, "content.md"),
		summary: handled.summary,
	};
}
