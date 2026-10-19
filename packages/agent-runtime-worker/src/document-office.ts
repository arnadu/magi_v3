/** XLSX and DOCX handling. */

import ExcelJS from "exceljs";
import mammoth from "mammoth";
import type { FileEntry } from "./artifacts.js";
import {
	imageDims,
	inspectImageHint,
	processUnsupported,
	selectImages,
	statusLine,
} from "./document-format.js";
import type {
	Handled,
	ProcessingStatus,
	ProcessLimits,
	RankableImage,
} from "./document-types.js";
import type { DescribeImageFn } from "./document-vision.js";
import { MIME_TO_EXT } from "./mime-types.js";

/** CSV-escape a cell value (quote if it contains comma, quote, or newline). */
export function csvCell(v: unknown): string {
	if (v === null || v === undefined) return "";
	const s =
		typeof v === "object" &&
		v !== null &&
		"text" in (v as Record<string, unknown>)
			? String((v as { text: unknown }).text) // exceljs rich text / hyperlink
			: String(v);
	return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function processXlsx(
	bytes: Buffer,
	filename: string,
	limits: ProcessLimits,
): Promise<Handled> {
	const wb = new ExcelJS.Workbook();
	try {
		// exceljs's types ask for ArrayBuffer; at runtime it takes a Node Buffer
		// (its own docs load from Buffer), and copying would double the memory.
		await wb.xlsx.load(bytes as unknown as ArrayBuffer);
	} catch (e) {
		return processUnsupported(
			bytes,
			filename,
			`Could not open workbook — ${(e as Error).message}.`,
		);
	}

	const files: FileEntry[] = [];
	const overview: string[] = [];
	for (const ws of wb.worksheets) {
		// getSheetValues() is 1-indexed with a leading null row and a leading null cell.
		const rows = (ws.getSheetValues() as unknown[][])
			.slice(1)
			.map((row) => (row ? row.slice(1).map(csvCell).join(",") : ""));
		const dataRows = Math.max(0, rows.length - 1);
		const safeName = `sheet-${ws.name.replace(/[^a-z0-9_-]+/gi, "_")}`;
		files.push({ name: `${safeName}.csv`, content: rows.join("\n") });
		overview.push(
			`### ${ws.name}\n` +
				`- ${dataRows} data rows × ${ws.columnCount} cols → \`${safeName}.csv\` (full data; Bash-slice it)\n` +
				`- header: \`${rows[0] ?? ""}\`\n` +
				"```\n" +
				rows.slice(0, limits.previewRows + 1).join("\n") +
				"\n```",
		);
	}

	const content = [
		statusLine("complete"),
		"",
		`# ${filename} (${wb.worksheets.length} sheet${wb.worksheets.length === 1 ? "" : "s"})`,
		"",
		overview.join("\n\n"),
	].join("\n");
	files.unshift({ name: "content.md", content });
	return {
		format: "xlsx",
		status: "complete",
		files,
		summary: `XLSX (${wb.worksheets.length} sheets)`,
	};
}

export async function processDocx(
	bytes: Buffer,
	filename: string,
	limits: ProcessLimits,
	describeImage: DescribeImageFn | undefined,
	artifactsDir: string,
): Promise<Handled> {
	// Collect embedded images during conversion; describe/defer them afterward
	// using the same policy as PDF/HTML.
	const collected: { name: string; bytes: Buffer; mime: string }[] = [];
	const convertImage = mammoth.images.imgElement(async (image) => {
		const buf = await image.read();
		const mime = image.contentType || "image/png";
		const ext = MIME_TO_EXT[mime] ?? "png";
		const name = `image-${collected.length + 1}.${ext}`;
		collected.push({ name, bytes: Buffer.from(buf), mime });
		return { src: name };
	});

	let markdown: string;
	try {
		// mammoth ships convertToMarkdown at runtime but omits it from its types;
		// it has the same signature as convertToHtml.
		const convertToMarkdown = (
			mammoth as unknown as {
				convertToMarkdown: typeof mammoth.convertToHtml;
			}
		).convertToMarkdown;
		const result = await convertToMarkdown({ buffer: bytes }, { convertImage });
		markdown = result.value;
	} catch (e) {
		return processUnsupported(
			bytes,
			filename,
			`Could not read DOCX — ${(e as Error).message}.`,
		);
	}

	const files: FileEntry[] = collected.map((c) => ({
		name: c.name,
		content: c.bytes,
	}));

	// Apply the describe-now/defer policy to embedded images.
	const ranked: RankableImage[] = collected.map((c, i) => {
		const dims = imageDims(c.bytes);
		return { index: i, width: dims?.width, height: dims?.height };
	});
	const selection = selectImages(ranked, limits);
	const describeSet = new Set(selection.describe);
	const imageNotes: string[] = [];
	const unprocessed: { item: string; reason: string }[] = [];
	for (let i = 0; i < collected.length; i++) {
		const c = collected[i];
		if (selection.decorative.includes(i)) {
			unprocessed.push({ item: c.name, reason: "decorative" });
			continue;
		}
		if (describeSet.has(i) && describeImage) {
			const desc = await describeImage(c.bytes, c.mime);
			imageNotes.push(
				`- \`${c.name}\`: ${desc ?? `(InspectImage("${inspectImageHint(artifactsDir, c.name)}") to analyze)`}`,
			);
		} else {
			imageNotes.push(
				`- \`${c.name}\`: not auto-described — InspectImage("${inspectImageHint(artifactsDir, c.name)}", "your question") to analyze`,
			);
			unprocessed.push({ item: c.name, reason: "over-budget" });
		}
	}

	const decorativeCount = selection.decorative.length;
	const status: ProcessingStatus =
		selection.deferred.length > 0 || decorativeCount > 0
			? "partial"
			: "complete";
	const parts = [
		statusLine(
			status,
			status === "partial"
				? `Full text included. ${selection.deferred.length} image(s) await InspectImage; ${decorativeCount} decorative image(s) omitted.`
				: undefined,
		),
		"",
		`# ${filename}`,
		"",
		markdown.trim() || "(No text extracted.)",
	];
	if (imageNotes.length > 0) {
		parts.push("", "## Images", "", imageNotes.join("\n"));
	}
	if (decorativeCount > 0) {
		parts.push(
			"",
			`*(${decorativeCount} smaller/decorative image(s) omitted from inline view — saved under the artifact, InspectImage if needed.)*`,
		);
	}
	files.unshift({ name: "content.md", content: parts.join("\n") });
	return {
		format: "docx",
		status,
		files,
		unprocessed: unprocessed.length > 0 ? unprocessed : undefined,
		summary: `DOCX${collected.length > 0 ? ` (${collected.length} images)` : ""}`,
	};
}
