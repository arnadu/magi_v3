/** PDF handling: text extraction with table reconstruction, scanned-page OCR, visual-page description. */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { FileEntry } from "./artifacts.js";
import {
	inspectImageHint,
	selectImages,
	statusLine,
} from "./document-format.js";
import type { ExtractedPage, PdfExtraction } from "./document-pdf-extract.js";
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

/** How long the worker may spend opening, extracting and rendering one PDF. */
export const PDF_EXTRACT_TIMEOUT_MS = 120_000;

/**
 * The compiled worker: next to this module in dist/, or dist/ itself when
 * running from src/ under vitest (the tool-executor pattern in tools.ts).
 */
function pdfWorkerPath(): string {
	const here = fileURLToPath(import.meta.url);
	return here.endsWith(".ts")
		? join(dirname(here), "..", "dist", "pdf-worker.js")
		: join(dirname(here), "pdf-worker.js");
}

/**
 * Run the synchronous mupdf work in a worker thread (#79): a 300-page
 * document used to block every agent's tool calls and the monitor for its
 * whole extraction. The worker is terminated on timeout or abort; either
 * comes back as `timedOut`, never a hang.
 */
function extractInWorker(
	bytes: Buffer,
	limits: ProcessLimits,
	signal?: AbortSignal,
): Promise<PdfExtraction | { ok: false; timedOut: string }> {
	return new Promise((resolve) => {
		const worker = new Worker(pdfWorkerPath(), {
			workerData: {
				bytes: new Uint8Array(bytes),
				limits: {
					maxTextPages: limits.maxTextPages,
					maxRenderPages: limits.maxRenderPages,
				},
			},
		});
		let settled = false;
		const finish = (r: PdfExtraction | { ok: false; timedOut: string }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			void worker.terminate();
			resolve(r);
		};
		const timer = setTimeout(
			() =>
				finish({
					ok: false,
					timedOut: `extraction did not finish within ${PDF_EXTRACT_TIMEOUT_MS / 1000}s`,
				}),
			PDF_EXTRACT_TIMEOUT_MS,
		);
		const onAbort = () =>
			finish({ ok: false, timedOut: "the run was aborted" });
		signal?.addEventListener("abort", onAbort, { once: true });
		worker.once("message", (r: PdfExtraction) => finish(r));
		worker.once("error", (e) =>
			finish({ ok: false, unreadable: `PDF worker failed: ${e.message}` }),
		);
		worker.once("exit", (code) => {
			if (code !== 0)
				finish({
					ok: false,
					unreadable: `PDF worker exited with code ${code}`,
				});
		});
	});
}

function timedOutPdf(bytes: Buffer, filename: string, why: string): Handled {
	return {
		format: "pdf",
		status: "partial",
		files: [
			{
				name: "content.md",
				content: statusLine(
					"partial",
					`PDF text extraction stopped — ${why}. Raw file saved as ${filename}; split it or read pages with InspectImage.`,
				),
			},
			{ name: filename, content: bytes },
		],
		unprocessed: [{ item: filename, reason: "extraction-timeout" }],
		summary: "PDF (extraction timed out)",
	};
}

type Unprocessed = { item: string; reason: string };

interface PageVision {
	describePageVisual: DescribeImageFn | undefined;
	ocrPage: OcrPageFn | undefined;
	artifactsDir: string;
}

function unreadablePdf(
	bytes: Buffer,
	filename: string,
	message: string,
): Handled {
	return {
		format: "pdf",
		status: "unsupported",
		files: [
			{
				name: "content.md",
				content: `${statusLine("unsupported", `Could not open PDF — ${message}. Raw file saved as ${filename}.`)}`,
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

/** A rendered page's file and visual note; a failed render keeps the text and marks the page partial (DOC10). */
async function renderedPage(
	page: ExtractedPage,
	pageNo: number,
	describeNow: boolean,
	v: PageVision,
): Promise<{ file?: FileEntry; note: string; unprocessed?: Unprocessed }> {
	const fileName = `page-${pageNo}.png`;
	if (!page.png) {
		return {
			note: `\n\n*(Page ${pageNo} render failed (${page.renderError ?? "unknown error"}) — text only.)*`,
			unprocessed: { item: fileName, reason: "render-failed" },
		};
	}
	const png = Buffer.from(page.png);
	const visual = await pageVisualNote(
		png,
		pageNo,
		fileName,
		{ isScanned: page.isScanned, needsVision: page.needsVision, describeNow },
		v,
	);
	return { file: { name: fileName, content: png }, ...visual };
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
	const extraction = await extractInWorker(bytes, limits, signal);
	if (!extraction.ok) {
		return "timedOut" in extraction
			? timedOutPdf(bytes, filename, extraction.timedOut)
			: unreadablePdf(bytes, filename, extraction.unreadable);
	}
	const { pageCount, pages } = extraction;
	const textCount = pages.length;
	const renderCount = Math.min(textCount, limits.maxRenderPages);
	// Page renders are full-page → all substantive; the budget caps how many we
	// describe (dimensionless items keep document order via selectImages).
	const renderItems: RankableImage[] = [];
	for (let i = 0; i < renderCount; i++) {
		if (pages[i].needsVision) renderItems.push({ index: i });
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
		const page = pages[i];
		let section = `## Page ${i + 1}`;
		if (page.text) section += `\n\n${page.text}`;
		if (i < renderCount) {
			const r = await renderedPage(page, i + 1, describeSet.has(i), vision);
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
