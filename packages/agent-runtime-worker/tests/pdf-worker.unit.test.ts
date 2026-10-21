/**
 * #79: PDF extraction runs in a worker thread. It still produces the same
 * document, and an aborted run comes back as a partial result instead of
 * holding the caller.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { processPdf } from "../src/document-pdf.js";
import { extractPdf } from "../src/document-pdf-extract.js";
import { DEFAULT_LIMITS } from "../src/document-types.js";

const PDF = readFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"..",
		"testdata",
		"documents",
		"test-pdf.pdf",
	),
);

const contentOf = (h: { files: { name: string; content: unknown }[] }) =>
	String(h.files.find((f) => f.name === "content.md")?.content);

describe("PDF extraction off the daemon thread (#79)", () => {
	it("extracts page text through the worker", async () => {
		const h = await processPdf(
			PDF,
			"report.pdf",
			DEFAULT_LIMITS,
			undefined,
			undefined,
			"/tmp",
		);
		expect(h.format).toBe("pdf");
		expect(contentOf(h)).toContain("## Page 1");
		expect(h.files.some((f) => f.name === "report.pdf")).toBe(true);
	});

	it("returns a partial result, raw PDF kept, when the run is aborted", async () => {
		const ac = new AbortController();
		const pending = processPdf(
			PDF,
			"report.pdf",
			DEFAULT_LIMITS,
			undefined,
			undefined,
			"/tmp",
			ac.signal,
		);
		ac.abort();
		const h = await pending;
		expect(h.status).toBe("partial");
		expect(contentOf(h)).toContain("the run was aborted");
		expect(h.files.some((f) => f.name === "report.pdf")).toBe(true);
	});

	it("reports an unreadable file as unsupported", async () => {
		const h = await processPdf(
			Buffer.from("not a pdf"),
			"bad.pdf",
			DEFAULT_LIMITS,
			undefined,
			undefined,
			"/tmp",
		);
		expect(h.status).toBe("unsupported");
	});

	it("extractPdf (the worker's body) returns text and renders within the limits", () => {
		const r = extractPdf(PDF, { maxTextPages: 300, maxRenderPages: 1 });
		if (!r.ok) throw new Error(r.unreadable);
		expect(r.pageCount).toBeGreaterThan(0);
		expect(r.pages[0].png?.byteLength).toBeGreaterThan(0);
		expect(r.pages.slice(1).every((p) => p.png === undefined)).toBe(true);
		expect(
			extractPdf(new Uint8Array([1, 2, 3]), {
				maxTextPages: 1,
				maxRenderPages: 1,
			}).ok,
		).toBe(false);
	});
});
