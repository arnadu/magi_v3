import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_LIMITS,
	type DescribeImageFn,
	detectFormat,
	processBuffer,
	selectImages,
} from "../src/document-processor.js";

const DOCS = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"testdata",
	"documents",
);

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "magi-docproc-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const PNG_MAGIC = Buffer.from("89504e470d0a1a0a", "hex");

// ---------------------------------------------------------------------------
// detectFormat
// ---------------------------------------------------------------------------

describe("detectFormat", () => {
	it("uses extension first (xlsx/docx sniff as zip)", () => {
		const zip = Buffer.from("504b0304", "hex");
		expect(detectFormat("book.xlsx", undefined, zip)).toBe("xlsx");
		expect(detectFormat("memo.docx", undefined, zip)).toBe("docx");
		expect(detectFormat("bundle.zip", undefined, zip)).toBe("zip");
	});

	it("falls back to magic bytes when extension is unknown", () => {
		expect(detectFormat("noext", undefined, PNG_MAGIC)).toBe("image");
		expect(detectFormat("noext", undefined, Buffer.from("%PDF-1.7"))).toBe(
			"pdf",
		);
	});

	it("falls back to MIME when extension and magic miss", () => {
		const plain = Buffer.from("hello");
		expect(detectFormat("x", "text/csv", plain)).toBe("csv");
		expect(detectFormat("x", "text/plain", plain)).toBe("text");
		expect(detectFormat("x", "image/webp", plain)).toBe("image");
		expect(detectFormat("x", undefined, plain)).toBe("unknown");
	});
});

// ---------------------------------------------------------------------------
// selectImages (the describe-now/defer policy)
// ---------------------------------------------------------------------------

describe("selectImages", () => {
	it("drops decorative images (sub-threshold dimension / extreme aspect)", () => {
		const sel = selectImages(
			[
				{ index: 0, width: 32, height: 32 }, // icon → decorative
				{ index: 1, width: 1200, height: 30 }, // banner (aspect 40) → decorative
				{ index: 2, width: 800, height: 600 }, // chart → substantive
			],
			DEFAULT_LIMITS,
		);
		expect(sel.decorative.sort()).toEqual([0, 1]);
		expect(sel.describe).toEqual([2]);
		expect(sel.deferred).toEqual([]);
	});

	it("describes the largest N and defers the rest (budget cap)", () => {
		const imgs = Array.from({ length: 15 }, (_, i) => ({
			index: i,
			width: 300 + i * 10, // strictly increasing area
			height: 300,
		}));
		const sel = selectImages(imgs, { ...DEFAULT_LIMITS, maxAutoDescribe: 10 });
		expect(sel.describe).toHaveLength(10);
		expect(sel.deferred).toHaveLength(5);
		// Largest-area first → index 14 (biggest) is described, index 0 deferred.
		expect(sel.describe).toContain(14);
		expect(sel.deferred).toContain(0);
	});

	it("treats dimensionless items (page renders) as always substantive", () => {
		const pages = Array.from({ length: 12 }, (_, i) => ({ index: i }));
		const sel = selectImages(pages, { ...DEFAULT_LIMITS, maxAutoDescribe: 10 });
		expect(sel.decorative).toEqual([]);
		expect(sel.describe).toHaveLength(10);
		expect(sel.deferred).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// processBuffer — text / csv / image / pdf
// ---------------------------------------------------------------------------

async function readContent(contentPath: string): Promise<string> {
	return readFile(contentPath, "utf8");
}

describe("processBuffer", () => {
	it("processes plain text without truncation", async () => {
		const text = `line\n`.repeat(500);
		const r = await processBuffer(Buffer.from(text), {
			filename: "notes.txt",
			artifactsDir: dir,
		});
		expect(r.format).toBe("text");
		expect(r.processingStatus).toBe("complete");
		const content = await readContent(r.contentPath);
		expect(content).toContain("✓ Fully processed");
		expect(content.match(/line/g)?.length).toBe(500); // nothing dropped
	});

	it("processes CSV with a preview and a full data.csv sibling", async () => {
		const rows = ["a,b,c", "1,2,3", "4,5,6", "7,8,9"].join("\n");
		const r = await processBuffer(Buffer.from(rows), {
			filename: "data.csv",
			artifactsDir: dir,
		});
		expect(r.format).toBe("csv");
		const content = await readContent(r.contentPath);
		expect(content).toContain("Rows: 3");
		expect(content).toContain("a,b,c");
		// Full data preserved verbatim for Bash slicing.
		const full = await readFile(
			join(dir, "artifacts", r.artifactId, "data.csv"),
			"utf8",
		);
		expect(full).toBe(rows);
	});

	it("describes a single uploaded image via the injected describe fn", async () => {
		const png = readFileSync(join(DOCS, "dog.png"));
		const describeImage: DescribeImageFn = async () => "a golden retriever";
		const r = await processBuffer(png, {
			filename: "dog.png",
			mimeType: "image/png",
			artifactsDir: dir,
			describeImage,
		});
		expect(r.format).toBe("image");
		const content = await readContent(r.contentPath);
		expect(content).toContain("a golden retriever");
		// The image file is saved for follow-up InspectImage.
		await expect(
			readFile(join(dir, "artifacts", r.artifactId, "image.png")),
		).resolves.toBeInstanceOf(Buffer);
	});

	it("extracts all PDF text and renders pages, respecting the describe budget", async () => {
		const pdf = readFileSync(join(DOCS, "test-pdf.pdf"));
		let describeCalls = 0;
		const describeImage: DescribeImageFn = async () => {
			describeCalls++;
			return "page summary";
		};
		const r = await processBuffer(pdf, {
			filename: "test-pdf.pdf",
			mimeType: "application/pdf",
			artifactsDir: dir,
			describeImage,
			limits: { maxAutoDescribe: 1 }, // force defer if >1 page
		});
		expect(r.format).toBe("pdf");
		const content = await readContent(r.contentPath);
		expect(content).toContain("Page 1");
		// Budget honored: at most maxAutoDescribe vision calls.
		expect(describeCalls).toBeLessThanOrEqual(1);
		// The source PDF is retained for recovery of deferred pages.
		await expect(
			readFile(join(dir, "artifacts", r.artifactId, "test-pdf.pdf")),
		).resolves.toBeInstanceOf(Buffer);
	});

	it("saves the raw file and marks unsupported for unknown formats", async () => {
		const r = await processBuffer(Buffer.from("\x00\x01binary"), {
			filename: "mystery.bin",
			artifactsDir: dir,
		});
		expect(r.processingStatus).toBe("unsupported");
		await expect(
			readFile(join(dir, "artifacts", r.artifactId, "mystery.bin")),
		).resolves.toBeInstanceOf(Buffer);
	});
});
