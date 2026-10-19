/**
 * Shared document processor — Sprint 25 phase 2; OCR fallback, image-text
 * transcription, and table reconstruction added 2026-09-11 (ADR-0028).
 *
 * Turns an uploaded file (raw bytes + filename) into an LLM-readable artifact:
 * a `content.md` plus extracted assets (page renders, the raw data file) under
 * `{artifactsDir}/artifacts/{id}/`, with a `meta.json` partial-processing marker.
 *
 * Design notes (ADR-0028 has the full pipeline walkthrough + rationale):
 *   - **No text truncation.** All text from every page/row is preserved; agents
 *     read slices with Bash. Only the expensive VISION step is budgeted.
 *   - **Image describe-now vs defer.** Auto-describing every image in a large
 *     document is slow and costly, so each image is either described now (up to a
 *     per-document budget, largest first) or deferred with an `InspectImage(path,
 *     question)` pointer in the markdown — the agent processes it on demand. There
 *     is no new tool: deferral rides on the existing InspectImage.
 *   - **A described image also gets its legible text transcribed**, not just
 *     captioned — one shared prompt/call asks for both (AUTO_DESCRIBE_PROMPT), so
 *     a screenshot or whiteboard photo's real text lands in content.md instead of
 *     a vague paraphrase, at no extra vision-call cost. Standalone/DOCX-embedded
 *     images only — deliberately NOT used for a PDF page's own visual note (see
 *     next bullet): that page's text is already extracted by mupdf, so asking a
 *     vision model to transcribe the same rendered page's text again doesn't
 *     recover anything, it reliably duplicates it (found live).
 *   - **A PDF page's rendered image is still worth a vision call even when the
 *     page already has real extracted text** — but only for what mupdf's text
 *     extraction structurally cannot see: embedded photos, charts, diagrams, a
 *     logo. `describePageVisual` (`PAGE_VISUAL_PROMPT`) is a separate,
 *     description-only prompt for exactly that, kept apart from `describeImage`
 *     at the type level so a page's visual note can never trigger a text
 *     transcription of content already sitting right above it in content.md.
 *   - **...and skipped entirely when there's provably nothing there to see.**
 *     `pageHasVisualContent()` checks the page's own Resources/XObject
 *     dictionary directly — mupdf's text extraction never reports a non-text
 *     visual element as an "image" (verified live: a real logo turned out to
 *     be a Form XObject, invisible to StructuredText even with
 *     "preserve-images"). A page with no XObject at all — most pages, in most
 *     documents — gets zero vision calls, not a wasted one.
 *   - **A PDF page with no usable extracted text (a scan) gets OCR'd**, not just
 *     described — SCANNED_TEXT_THRESHOLD decides per page, and this runs
 *     independently of the describe-now/defer budget above: a page with zero
 *     real text is a correctness gap, not a nice-to-have caption.
 *   - **Table structure is reconstructed from PDF geometry**, not left as mupdf's
 *     flat per-cell text dump — see pdf-tables.ts.
 *   - **Partial-processing is first-class.** `meta.json.processingStatus` is
 *     `complete | partial | unsupported`, and `content.md` opens with a visible
 *     status line so the agent knows what is and isn't narrated.
 *
 * The vision call is injected as `describeImage`/`describePageVisual`/`ocrPage`
 * so this module has no LLM dependency and is fully unit-testable; production
 * wires all three to the vision model already configured for the mission
 * (VISION_MODEL / OPENROUTER_API_KEY) — see createDescribeImage/
 * createPageVisualDescribe/createOcrPage, and their call sites in
 * monitor-server.ts (uploads) and tools/fetch-url.ts (web fetches).
 *
 * Formats: plain text / Markdown, CSV, single images, PDF (mupdf), XLSX (exceljs →
 * one CSV per sheet), DOCX (mammoth → markdown + embedded-image policy), and ZIP
 * (jszip → each contained file processed into its own artifact, nested zips left
 * un-expanded). Embedded-image dimensions come from `image-size`.
 */

import { join } from "node:path";
import {
	type ArtifactMeta,
	generateArtifactId,
	saveArtifact,
} from "./artifacts.js";
import {
	detectFormat,
	inspectImageHint,
	processUnsupported,
	statusLine,
} from "./document-format.js";
import { processDocx, processXlsx } from "./document-office.js";
import { processPdf } from "./document-pdf.js";
import {
	DEFAULT_LIMITS,
	type Handled,
	type ProcessLimits,
	type ProcessOptions,
	type ProcessResult,
} from "./document-types.js";
import type { DescribeImageFn } from "./document-vision.js";
import { processZip } from "./document-zip.js";
import { MIME_TO_EXT } from "./mime-types.js";

export {
	detectFormat,
	processUnsupported,
	selectImages,
	statusLine,
} from "./document-format.js";
export {
	DEFAULT_LIMITS,
	DocFormat,
	Handled,
	ImageSelection,
	ProcessingStatus,
	ProcessLimits,
	ProcessOptions,
	ProcessResult,
	RankableImage,
} from "./document-types.js";
export {
	createDescribeImage,
	createOcrPage,
	createPageVisualDescribe,
	DescribeImageFn,
	OcrPageFn,
} from "./document-vision.js";

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
	artifactsDir: string,
): Promise<Handled> {
	const cleanMime = mimeType.split(";")[0].trim() || "image/jpeg";
	const ext = MIME_TO_EXT[cleanMime] ?? filename.split(".").pop() ?? "jpg";
	const imageName = `image.${ext}`;
	const description = describeImage
		? await describeImage(bytes, cleanMime)
		: undefined;
	const body = description
		? `${description}`
		: `(Not described automatically — InspectImage("${inspectImageHint(artifactsDir, imageName)}", "your question") to analyze.)`;
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

/** mupdf's own JSON shape (undocumented in its .d.ts, which only types asJSON()
 * as returning a string) — only the fields reconstructPageText() needs. */

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
	let format = detectFormat(opts.filename, opts.mimeType, bytes);
	const mime = opts.mimeType ?? "application/octet-stream";

	// An archive inside an archive is listed, never expanded — by content,
	// so an inner ZIP named `layer.dat` is caught too.
	const nestedZip = format === "zip" && (opts.zipDepth ?? 0) >= 1;
	if (nestedZip) format = "unknown";

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
				opts.artifactsDir,
			);
			break;
		case "pdf":
			handled = await processPdf(
				bytes,
				opts.filename,
				limits,
				opts.describePageVisual,
				opts.ocrPage,
				opts.artifactsDir,
				opts.signal,
			);
			break;
		case "xlsx":
			handled = await processXlsx(bytes, opts.filename, limits);
			break;
		case "docx":
			handled = await processDocx(
				bytes,
				opts.filename,
				limits,
				opts.describeImage,
				opts.artifactsDir,
			);
			break;
		case "zip":
			handled = await processZip(
				bytes,
				opts.filename,
				opts,
				limits,
				processBuffer,
			);
			break;
		default:
			handled = nestedZip
				? {
						...processUnsupported(
							bytes,
							opts.filename,
							`Nested ZIP "${opts.filename}" is not expanded — archives inside archives are listed only. Raw file saved alongside.`,
						),
						format: "zip",
					}
				: processUnsupported(bytes, opts.filename);
	}

	const artifactId = generateArtifactId(opts.sourceUrl ?? opts.filename);
	const meta: ArtifactMeta = {
		"@type": "DigitalDocument",
		id: artifactId,
		name: opts.filename,
		dateCreated: new Date().toISOString(),
		encodingFormat: mime,
		processingStatus: handled.status,
		...(opts.sourceUrl ? { url: opts.sourceUrl } : {}),
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
		unprocessed: handled.unprocessed,
		contentPath: join(dir, "content.md"),
		summary: handled.summary,
	};
}
