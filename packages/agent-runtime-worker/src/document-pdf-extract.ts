/**
 * The synchronous half of PDF processing: open the document, extract each
 * page's text, decide which pages need a vision call, and render pages to
 * PNG. Pure mupdf work with no I/O, run inside pdf-worker.ts so a long
 * document does not block the daemon's event loop (#79).
 */

import * as mupdf from "mupdf";
import {
	PDF_SCALE,
	pageHasVisualContent,
	SCANNED_TEXT_THRESHOLD,
} from "./document-format.js";
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

/** One extracted page: its text, and — within the render limit — its PNG or why the render failed. */
export interface ExtractedPage {
	text: string;
	isScanned: boolean;
	/** Scanned (needs OCR) or provably has non-text visual content; false past the render limit. */
	needsVision: boolean;
	png?: Uint8Array;
	renderError?: string;
}

export type PdfExtraction =
	| { ok: true; pageCount: number; pages: ExtractedPage[] }
	| { ok: false; unreadable: string };

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

const MATRIX: [number, number, number, number, number, number] = [
	PDF_SCALE,
	0,
	0,
	PDF_SCALE,
	0,
	0,
];

/**
 * Load each page once (up to `maxTextPages`), extract its text, and — up to
 * `maxRenderPages` — decide whether it needs a vision call and render it. A
 * page that is neither scanned nor visual (the common case: plain typed
 * text) never competes for the describe budget. A failed render keeps the
 * page's text (DOC10).
 */
export function extractPdf(
	bytes: Uint8Array,
	limits: { maxTextPages: number; maxRenderPages: number },
): PdfExtraction {
	let doc: mupdf.Document;
	try {
		doc = mupdf.Document.openDocument(bytes, "application/pdf");
	} catch (e) {
		return { ok: false, unreadable: (e as Error).message };
	}
	const pageCount = doc.countPages();
	const textCount = Math.min(pageCount, limits.maxTextPages);
	const renderCount = Math.min(textCount, limits.maxRenderPages);
	const pages: ExtractedPage[] = [];
	for (let i = 0; i < textCount; i++) {
		const page = doc.loadPage(i);
		const { text, rawLength } = extractPageText(page);
		const isScanned = rawLength < SCANNED_TEXT_THRESHOLD;
		const extracted: ExtractedPage = {
			text: text.trim(),
			isScanned,
			needsVision: i < renderCount && (isScanned || pageHasVisualContent(page)),
		};
		if (i < renderCount) {
			try {
				const pixmap = page.toPixmap(MATRIX, mupdf.ColorSpace.DeviceRGB, false);
				// A copy, not mupdf's own buffer: it may be a view into the WASM
				// heap, and transferring that to the main thread would detach it.
				extracted.png = new Uint8Array(pixmap.asPNG());
			} catch (e) {
				extracted.renderError = (e as Error).message;
			}
		}
		pages.push(extracted);
	}
	return { ok: true, pageCount, pages };
}
