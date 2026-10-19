/** PDF handling: text extraction with table reconstruction, scanned-page OCR, visual-page description. */

import * as mupdf from "mupdf";
import type { FileEntry } from "./artifacts.js";
import {
	inspectImageHint,
	PDF_SCALE,
	pageHasVisualContent,
	SCANNED_TEXT_THRESHOLD,
	selectImages,
	statusLine,
} from "./document-format.js";
import type {
	Handled,
	ProcessingStatus,
	ProcessLimits,
	RankableImage,
} from "./document-types.js";
import {
	type DescribeImageFn,
	type OcrPageFn,
	UNTRUSTED_NOTE,
} from "./document-vision.js";
import { reconstructPageText, type StextLine } from "./pdf-tables.js";

export interface StextJson {
	blocks: Array<{
		type: string;
		lines?: Array<{
			text: string;
			bbox: { x: number; y: number; w: number; h: number };
		}>;
	}>;
}

/** Extracts a page's text via mupdf's structured JSON rather than `.asText()`,
 * upgrading tabular regions into real Markdown tables (see pdf-tables.ts).
 * `rawLength` — the sum of trimmed line lengths before Markdown formatting —
 * is what the scanned-page check (SCANNED_TEXT_THRESHOLD) should measure, not
 * `text.length`: the formatted/joined output's length depends on incidental
 * choices (blank-line collapsing, `| --- |` table overhead) that have nothing
 * to do with how much real text mupdf actually found on the page. */
export function extractPageText(page: mupdf.Page): {
	text: string;
	rawLength: number;
} {
	const json = JSON.parse(page.toStructuredText().asJSON()) as StextJson;
	const lines: StextLine[] = [];
	let rawLength = 0;
	for (const block of json.blocks) {
		if (block.type !== "text") continue;
		for (const l of block.lines ?? []) {
			lines.push({
				text: l.text,
				x: l.bbox.x,
				y: l.bbox.y,
				w: l.bbox.w,
				h: l.bbox.h,
			});
			rawLength += l.text.trim().length;
		}
	}
	return { text: reconstructPageText(lines), rawLength };
}

/**
 * Pre-pass: load each page once (up to the text limit), extract its text,
 * and decide whether it needs a vision call at all — scanned (needs OCR) or
 * provably has some non-text visual content (pageHasVisualContent). A page
 * that is neither (the common case: a page of plain typed text) never
 * competes for the describe-now/defer budget, and never gets a vision call —
 * there is nothing on it a caption could add. This also stops a scanned page
 * from occupying a budget slot that a real logo/chart elsewhere in the
 * document could have used instead — a scanned page's own fate is decided by
 * the OCR branch regardless of describeSet membership.
 */
export function prescanPdfPages(
	doc: mupdf.Document,
	textCount: number,
	renderCount: number,
): {
	pages: mupdf.Page[];
	pageInfo: { text: string; isScanned: boolean }[];
	needsVisionCall: boolean[];
} {
	const pages: mupdf.Page[] = [];
	const pageInfo: { text: string; isScanned: boolean }[] = [];
	const needsVisionCall: boolean[] = [];
	for (let i = 0; i < textCount; i++) {
		const page = doc.loadPage(i);
		pages.push(page);
		const { text, rawLength } = extractPageText(page);
		const isScanned = rawLength < SCANNED_TEXT_THRESHOLD;
		pageInfo.push({ text: text.trim(), isScanned });
		needsVisionCall.push(
			i < renderCount && (isScanned || pageHasVisualContent(page)),
		);
	}
	return { pages, pageInfo, needsVisionCall };
}

const MATRIX: [number, number, number, number, number, number] = [
	PDF_SCALE,
	0,
	0,
	PDF_SCALE,
	0,
	0,
];

type Unprocessed = { item: string; reason: string };

interface PageVision {
	describePageVisual: DescribeImageFn | undefined;
	ocrPage: OcrPageFn | undefined;
	artifactsDir: string;
}

function unreadablePdf(bytes: Buffer, filename: string, e: unknown): Handled {
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

/**
 * What a rendered page adds to its section: an OCR transcription for a
 * scanned page, a visual description when the page has visual content and
 * is within the describe budget, or a pointer to InspectImage otherwise.
 */
async function pageVisualNote(
	png: Buffer,
	pageNo: number,
	fileName: string,
	p: { isScanned: boolean; needsVision: boolean; describeNow: boolean },
	v: PageVision,
): Promise<{ note: string; unprocessed?: Unprocessed }> {
	const hint = inspectImageHint(v.artifactsDir, fileName);
	if (p.isScanned && v.ocrPage) {
		const transcribed = await v.ocrPage(png, "image/png");
		return transcribed
			? {
					note: `\n\n*(No embedded text layer — transcribed via OCR. ${UNTRUSTED_NOTE})*\n\n${transcribed}`,
				}
			: {
					note: `\n\n*(Scanned page, OCR failed — InspectImage("${hint}") to transcribe manually.)*`,
					unprocessed: { item: fileName, reason: "ocr-failed" },
				};
	}
	// Provably nothing here a vision call could add (no text-layer concern, no
	// Image/Form XObject on the page): fully processed, no note.
	if (!p.needsVision) return { note: "" };
	if (p.describeNow && v.describePageVisual) {
		const desc = await v.describePageVisual(png, "image/png");
		return desc
			? { note: `\n\n**Page visual** (${UNTRUSTED_NOTE}): ${desc}` }
			: {
					note: `\n\n*(Page ${pageNo} visual: description failed — InspectImage("${hint}") to analyze.)*`,
					unprocessed: { item: fileName, reason: "describe-failed" },
				};
	}
	return {
		note: `\n\n*(Page ${pageNo} rendered but not auto-described — InspectImage("${hint}", "your question") to analyze.)*`,
		unprocessed: { item: fileName, reason: "over-budget" },
	};
}

/** Render a page to PNG and add its visual note; a failed render keeps the text and marks the page partial (DOC10). */
async function renderPage(
	page: mupdf.Page,
	pageNo: number,
	p: { isScanned: boolean; needsVision: boolean; describeNow: boolean },
	v: PageVision,
): Promise<{ file?: FileEntry; note: string; unprocessed?: Unprocessed }> {
	const fileName = `page-${pageNo}.png`;
	try {
		const pixmap = page.toPixmap(MATRIX, mupdf.ColorSpace.DeviceRGB, false);
		const png = Buffer.from(pixmap.asPNG());
		const visual = await pageVisualNote(png, pageNo, fileName, p, v);
		return { file: { name: fileName, content: png }, ...visual };
	} catch (e) {
		return {
			note: `\n\n*(Page ${pageNo} render failed (${(e as Error).message}) — text only.)*`,
			unprocessed: { item: fileName, reason: "render-failed" },
		};
	}
}

export async function processPdf(
	bytes: Buffer,
	filename: string,
	limits: ProcessLimits,
	describePageVisual: DescribeImageFn | undefined,
	ocrPage: OcrPageFn | undefined,
	artifactsDir: string,
	signal?: AbortSignal,
): Promise<Handled> {
	let doc: mupdf.Document;
	try {
		doc = mupdf.Document.openDocument(bytes, "application/pdf");
	} catch (e) {
		return unreadablePdf(bytes, filename, e);
	}
	const pageCount = doc.countPages();
	const textCount = Math.min(pageCount, limits.maxTextPages);
	const renderCount = Math.min(textCount, limits.maxRenderPages);
	const { pages, pageInfo, needsVisionCall } = prescanPdfPages(
		doc,
		textCount,
		renderCount,
	);
	// Page renders are full-page → all substantive; the budget caps how many we
	// describe (dimensionless items keep document order via selectImages).
	const renderItems: RankableImage[] = [];
	for (let i = 0; i < renderCount; i++) {
		if (needsVisionCall[i]) renderItems.push({ index: i });
	}
	const selection = selectImages(renderItems, limits);
	const describeSet = new Set(selection.describe);
	const vision = { describePageVisual, ocrPage, artifactsDir };

	const files: FileEntry[] = [];
	const sections: string[] = [];
	const unprocessed: Unprocessed[] = [];
	for (let i = 0; i < pageCount; i++) {
		if (signal?.aborted) break;
		if (i >= textCount) {
			sections.push(
				`## Page ${i + 1}\n\n*(Page ${i + 1} not extracted — beyond the ${limits.maxTextPages}-page text limit. Raw PDF saved as ${filename}.)*`,
			);
			unprocessed.push({ item: `page-${i + 1}`, reason: "beyond-text-limit" });
			continue;
		}
		const { text, isScanned } = pageInfo[i];
		let section = `## Page ${i + 1}`;
		if (text) section += `\n\n${text}`;
		if (i < renderCount) {
			const r = await renderPage(
				pages[i],
				i + 1,
				{
					isScanned,
					needsVision: needsVisionCall[i],
					describeNow: describeSet.has(i),
				},
				vision,
			);
			if (r.file) files.push(r.file);
			if (r.unprocessed) unprocessed.push(r.unprocessed);
			section += r.note;
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
	return pdfResult(filename, files, sections, unprocessed, {
		pageCount,
		renderCount,
		deferred: selection.deferred.length,
	});
}

function pdfResult(
	filename: string,
	files: FileEntry[],
	sections: string[],
	unprocessed: Unprocessed[],
	counts: { pageCount: number; renderCount: number; deferred: number },
): Handled {
	const { pageCount, renderCount, deferred } = counts;
	const status: ProcessingStatus =
		unprocessed.length > 0 ? "partial" : "complete";
	const detail =
		status === "partial"
			? `Text for all ${pageCount} pages is included. ${deferred} rendered page(s) await InspectImage; ${pageCount - renderCount} page(s) beyond the render limit.`
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
