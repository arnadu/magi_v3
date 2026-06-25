import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { processBuffer } from "../src/document-processor.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "magi-docproc-office-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const content = (id: string) =>
	readFile(join(dir, "artifacts", id, "content.md"), "utf8");

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

describe("processBuffer — XLSX", () => {
	it("writes one full CSV per sheet plus a preview overview", async () => {
		const wb = new ExcelJS.Workbook();
		const ws = wb.addWorksheet("Revenue");
		ws.addRow(["quarter", "usd"]);
		for (let q = 1; q <= 8; q++) ws.addRow([`Q${q}`, q * 1000]);
		const buf = Buffer.from(await wb.xlsx.writeBuffer());

		const r = await processBuffer(buf, {
			filename: "book.xlsx",
			artifactsDir: dir,
		});
		expect(r.format).toBe("xlsx");
		const md = await content(r.artifactId);
		expect(md).toContain("Revenue");
		expect(md).toContain("8 data rows");

		// Full sheet data is preserved verbatim for Bash slicing.
		const csv = await readFile(
			join(dir, "artifacts", r.artifactId, "sheet-Revenue.csv"),
			"utf8",
		);
		const rows = csv.trim().split("\n");
		expect(rows[0]).toBe("quarter,usd");
		expect(rows).toHaveLength(9); // header + 8 rows, none dropped
		expect(rows[8]).toBe("Q8,8000");
	});
});

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

describe("processBuffer — ZIP", () => {
	it("processes each contained file into its own artifact and indexes them", async () => {
		const zip = new JSZip();
		zip.file("notes.txt", "hello from inside the zip");
		zip.file("data.csv", "a,b\n1,2\n3,4");
		const buf = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

		const r = await processBuffer(buf, {
			filename: "bundle.zip",
			artifactsDir: dir,
		});
		expect(r.format).toBe("zip");
		const md = await content(r.artifactId);
		// Index references child artifacts.
		expect(md).toContain("notes.txt");
		expect(md).toContain("data.csv");
		expect(md).toMatch(/artifact `.+` \(text/);
		expect(md).toMatch(/artifact `.+` \(csv/);
	});

	it("does not expand nested zips (one level deep)", async () => {
		const inner = new JSZip();
		inner.file("deep.txt", "x");
		const innerBuf = await inner.generateAsync({ type: "nodebuffer" });
		const outer = new JSZip();
		outer.file("inner.zip", innerBuf);
		outer.file("top.txt", "y");
		const buf = Buffer.from(await outer.generateAsync({ type: "nodebuffer" }));

		const r = await processBuffer(buf, {
			filename: "outer.zip",
			artifactsDir: dir,
		});
		expect(r.processingStatus).toBe("partial");
		const md = await content(r.artifactId);
		expect(md).toContain("nested ZIP, not expanded");
	});
});

// ---------------------------------------------------------------------------
// DOCX (minimal hand-built fixture)
// ---------------------------------------------------------------------------

async function minimalDocx(text: string): Promise<Buffer> {
	const zip = new JSZip();
	zip.file(
		"[Content_Types].xml",
		`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
	);
	zip.file(
		"_rels/.rels",
		`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
	);
	zip.file(
		"word/document.xml",
		`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
	);
	return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

describe("processBuffer — DOCX", () => {
	it("extracts text via mammoth", async () => {
		const buf = await minimalDocx("Privacy assessment summary paragraph");
		const r = await processBuffer(buf, {
			filename: "memo.docx",
			artifactsDir: dir,
		});
		expect(r.format).toBe("docx");
		const md = await content(r.artifactId);
		// mammoth markdown may escape punctuation; match the unescaped words.
		expect(md).toContain("Privacy assessment summary paragraph");
	});
});
