/**
 * Worker-thread entry for PDF extraction (#79). Receives the PDF bytes and
 * limits, runs the synchronous mupdf work (document-pdf-extract.ts), and
 * posts the result back with the page PNGs transferred, not copied.
 */

import { parentPort, workerData } from "node:worker_threads";
import { extractPdf } from "./document-pdf-extract.js";

const { bytes, limits } = workerData as {
	bytes: Uint8Array;
	limits: { maxTextPages: number; maxRenderPages: number };
};

const result = extractPdf(bytes, limits);
const transfer = result.ok
	? result.pages.flatMap((p) => (p.png ? [p.png.buffer as ArrayBuffer] : []))
	: [];
parentPort?.postMessage(result, transfer);
