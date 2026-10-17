/**
 * Per-document OCR budget (DOC8). A 300-page scan used to mean 300 vision
 * calls before anyone could react; past the cap the remaining pages fall back
 * to the "transcribe manually with InspectImage" pointer the caller already
 * emits for a failed page.
 */

import type { OcrPageFn } from "./document-processor.js";

/** One factory call = one document: this many OCR pages per document, no more (DOC8). */
export const MAX_OCR_PAGES_PER_DOCUMENT = 40;

export function withOcrPageCap(fn: OcrPageFn, maxPages: number): OcrPageFn {
	let calls = 0;
	return async (bytes, mimeType) => {
		calls++;
		if (calls > maxPages) {
			if (calls === maxPages + 1) {
				console.warn(
					`[document-processor] OCR cap of ${maxPages} pages reached for this document — further scanned pages are left for InspectImage`,
				);
			}
			return undefined;
		}
		return fn(bytes, mimeType);
	};
}
