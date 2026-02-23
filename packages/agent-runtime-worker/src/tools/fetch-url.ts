import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Readability } from "@mozilla/readability";
import { Type } from "@sinclair/typebox";
import { JSDOM } from "jsdom";
import * as mupdf from "mupdf";
import {
	type ArtifactMeta,
	type FileEntry,
	generateArtifactId,
	saveArtifact,
} from "../artifacts.js";
import type { MagiTool, ToolResult } from "../tools.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image
/** Scale factor when rendering PDF pages to PNG. 1.5 ≈ 108 DPI — good for vision. */
const PDF_RENDER_SCALE = 1.5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(text: string): ToolResult {
	return { content: [{ type: "text", text }] };
}

function toolErr(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

/** Map common image MIME types to file extensions. */
const MIME_TO_EXT: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/avif": "avif",
	"image/svg+xml": "svg",
};

/** Derive file extension from a URL's pathname as a fallback. */
function extFromPath(pathname: string): string {
	const dot = pathname.lastIndexOf(".");
	if (dot === -1) return "jpg";
	const raw = pathname
		.slice(dot + 1)
		.split("?")[0]
		.toLowerCase();
	return raw || "jpg";
}

/** Infer content type from a local file path extension. */
function contentTypeFromPath(path: string): string {
	const lower = path.toLowerCase();
	if (lower.endsWith(".pdf")) return "application/pdf";
	if (lower.endsWith(".txt")) return "text/plain";
	return "text/html"; // default for file:// sources
}

/**
 * Fetch raw bytes + Content-Type from an http(s) or file URL.
 * For file:// URLs the Content-Type is derived from the file extension.
 */
async function fetchResource(
	url: URL,
	signal?: AbortSignal,
): Promise<{ bytes: Buffer; contentType: string }> {
	if (url.protocol === "file:") {
		const filePath = fileURLToPath(url);
		const bytes = await readFile(filePath);
		return { bytes, contentType: contentTypeFromPath(filePath) };
	}
	const res = await fetch(url.toString(), { signal });
	if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
	const contentType =
		res.headers.get("content-type") ?? "application/octet-stream";
	const bytes = Buffer.from(await res.arrayBuffer());
	return { bytes, contentType };
}

/**
 * Fetch a single image. Returns null if the image exceeds the size limit or
 * the request fails.
 */
async function fetchImage(
	imgUrl: string,
	signal?: AbortSignal,
): Promise<{ bytes: Buffer; ext: string } | null> {
	try {
		const parsed = new URL(imgUrl);
		let bytes: Buffer;
		let mimeType = "image/jpeg";

		if (parsed.protocol === "file:") {
			bytes = await readFile(fileURLToPath(parsed));
			const e = extFromPath(parsed.pathname);
			mimeType =
				Object.entries(MIME_TO_EXT).find(([, v]) => v === e)?.[0] ??
				"image/jpeg";
		} else {
			const res = await fetch(imgUrl, { signal });
			if (!res.ok) return null;
			const cl = Number(res.headers.get("content-length") ?? "0");
			if (cl > MAX_IMAGE_BYTES) return null;
			bytes = Buffer.from(await res.arrayBuffer());
			mimeType = res.headers.get("content-type") ?? "image/jpeg";
		}

		if (bytes.length > MAX_IMAGE_BYTES) return null;
		const ext =
			MIME_TO_EXT[mimeType.split(";")[0].trim()] ??
			extFromPath(parsed.pathname);
		return { bytes, ext };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// PDF processing
// ---------------------------------------------------------------------------

/**
 * Extract text and render pages from a PDF using mupdf.
 * Returns the artifact files and a summary string.
 */
async function processPdf(
	bytes: Buffer,
	workdir: string,
	rawUrl: string,
): Promise<ToolResult> {
	let doc: mupdf.Document;
	try {
		doc = mupdf.Document.openDocument(bytes, "application/pdf");
	} catch (e) {
		return toolErr(`FetchUrl: could not open PDF — ${(e as Error).message}`);
	}

	const pageCount = doc.countPages();
	const textParts: string[] = [];
	const imageFiles: FileEntry[] = [];
	const imageRelPaths: string[] = [];

	// Mupdf transform matrix for scaling: [sx, 0, 0, sy, 0, 0]
	const matrix: [number, number, number, number, number, number] = [
		PDF_RENDER_SCALE,
		0,
		0,
		PDF_RENDER_SCALE,
		0,
		0,
	];

	for (let i = 0; i < pageCount; i++) {
		const page = doc.loadPage(i);

		// Text extraction
		const pageText = page.toStructuredText().asText().trim();
		if (pageText) textParts.push(`## Page ${i + 1}\n\n${pageText}`);

		// Page render → PNG
		try {
			const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);
			const pngBytes = pixmap.asPNG();
			const filename = `page-${i + 1}.png`;
			imageFiles.push({ name: filename, content: Buffer.from(pngBytes) });
			imageRelPaths.push(filename);
		} catch {
			// Non-fatal: skip page render on error
		}
	}

	const contentText =
		textParts.join("\n\n---\n\n") || "(No text content extracted from PDF)";

	const artifactId = generateArtifactId(rawUrl);
	const meta: ArtifactMeta = {
		"@type": "DigitalDocument",
		id: artifactId,
		name: `PDF (${pageCount} page${pageCount !== 1 ? "s" : ""})`,
		url: rawUrl,
		dateCreated: new Date().toISOString(),
		encodingFormat: "application/pdf",
		...(imageRelPaths.length > 0 ? { images: imageRelPaths } : {}),
	};

	const files: FileEntry[] = [
		{ name: "content.md", content: contentText },
		...imageFiles,
	];

	try {
		await saveArtifact(workdir, artifactId, files, meta);
	} catch (e) {
		return toolErr(
			`FetchUrl: failed to save PDF artifact — ${(e as Error).message}`,
		);
	}

	const lines = [
		`Fetched PDF: ${rawUrl}`,
		`Artifact id: ${artifactId}`,
		`  artifacts/${artifactId}/content.md  (${contentText.length} chars, ${pageCount} pages)`,
		...imageRelPaths.map((p) => `  artifacts/${artifactId}/${p}`),
		"",
		`Use \`cat artifacts/${artifactId}/content.md\` to read the extracted text.`,
		`Use InspectImage with a page path (e.g. "artifacts/${artifactId}/page-1.png") to visually analyse a page.`,
	];

	return ok(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create the FetchUrl tool.
 *
 * Fetches a URL and saves the content as an artifact under
 * `{workdir}/artifacts/{id}/`:
 *   - HTML: processed with Readability (clean text) + embedded images downloaded
 *   - PDF:  text extracted + each page rendered to PNG with mupdf
 *
 * The artifact id is returned so agents can use
 * `cat artifacts/<id>/content.md` or InspectImage on any saved file.
 */
export function createFetchUrlTool(workdir: string): MagiTool {
	return {
		name: "FetchUrl",
		description:
			"Fetch a URL and save its content as an artifact in artifacts/. " +
			"Supports HTML pages (extracts clean article text and downloads embedded images) " +
			"and PDF files (extracts text and renders each page as a PNG). " +
			"Returns the artifact id; use `cat artifacts/<id>/content.md` to read the text " +
			"or InspectImage to visually analyse downloaded images or PDF pages.",
		parameters: Type.Object({
			url: Type.String({
				description: "URL to fetch (http://, https://, or file://)",
			}),
			download_images: Type.Optional(
				Type.Boolean({
					description: "Download <img> images from HTML pages (default: true)",
				}),
			),
		}),

		async execute(_id, args, signal) {
			const rawUrl = args.url as string;
			const downloadImages = args.download_images !== false;

			// --- Validate URL --------------------------------------------------
			let parsedUrl: URL;
			try {
				parsedUrl = new URL(rawUrl);
			} catch {
				return toolErr(`FetchUrl: invalid URL "${rawUrl}"`);
			}
			if (!["http:", "https:", "file:"].includes(parsedUrl.protocol)) {
				return toolErr(
					`FetchUrl: unsupported protocol "${parsedUrl.protocol}". Use http, https, or file.`,
				);
			}

			// --- Fetch primary resource ----------------------------------------
			let bytes: Buffer;
			let contentType: string;
			try {
				({ bytes, contentType } = await fetchResource(parsedUrl, signal));
			} catch (e) {
				return toolErr(`FetchUrl: fetch failed — ${(e as Error).message}`);
			}

			const mimeType = contentType.split(";")[0].trim().toLowerCase();

			// --- Route by content type -----------------------------------------
			if (mimeType === "application/pdf") {
				return processPdf(bytes, workdir, rawUrl);
			}

			if (
				!mimeType.startsWith("text/html") &&
				!mimeType.startsWith("text/plain")
			) {
				return toolErr(
					`FetchUrl: unsupported content type "${mimeType}". Supported: HTML, PDF, plain text.`,
				);
			}

			// --- Parse HTML with jsdom + Readability ---------------------------
			const html = bytes.toString("utf8");
			const dom = new JSDOM(html, { url: parsedUrl.toString() });
			const reader = new Readability(dom.window.document);
			const article = reader.parse();

			const title =
				article?.title ||
				dom.window.document.title ||
				parsedUrl.pathname.split("/").pop() ||
				"Untitled";

			const contentText = article?.textContent?.trim() || html;

			// --- Download images -----------------------------------------------
			const imageFiles: FileEntry[] = [];
			const imageRelPaths: string[] = [];

			if (downloadImages) {
				const imgEls = Array.from(
					dom.window.document.querySelectorAll("img"),
				).slice(0, MAX_IMAGES);

				let idx = 0;
				for (const img of imgEls) {
					const src = img.getAttribute("src");
					if (!src) continue;

					let imgUrl: string;
					try {
						imgUrl = new URL(src, parsedUrl.toString()).toString();
					} catch {
						continue;
					}

					const result = await fetchImage(imgUrl, signal);
					if (!result) continue;

					const filename = `image-${idx}.${result.ext}`;
					imageFiles.push({ name: filename, content: result.bytes });
					imageRelPaths.push(filename);
					idx++;
				}
			}

			// --- Save artifact -------------------------------------------------
			const artifactId = generateArtifactId(rawUrl);
			const meta: ArtifactMeta = {
				"@type": "Article",
				id: artifactId,
				name: title,
				url: rawUrl,
				dateCreated: new Date().toISOString(),
				encodingFormat: mimeType,
				...(imageRelPaths.length > 0 ? { images: imageRelPaths } : {}),
			};

			const files: FileEntry[] = [
				{ name: "content.md", content: contentText },
				...imageFiles,
			];

			try {
				await saveArtifact(workdir, artifactId, files, meta);
			} catch (e) {
				return toolErr(
					`FetchUrl: failed to save artifact — ${(e as Error).message}`,
				);
			}

			// --- Return summary ------------------------------------------------
			const lines = [
				`Fetched: ${rawUrl}`,
				`Artifact id: ${artifactId}`,
				`  artifacts/${artifactId}/content.md  (${contentText.length} chars)`,
			];
			for (const p of imageRelPaths) {
				lines.push(`  artifacts/${artifactId}/${p}`);
			}
			lines.push(
				"",
				`Use \`cat artifacts/${artifactId}/content.md\` to read the article.`,
			);
			if (imageRelPaths.length > 0) {
				lines.push(
					`Use InspectImage with path "artifacts/${artifactId}/${imageRelPaths[0]}" to analyse images.`,
				);
			}

			return ok(lines.join("\n"));
		},
	};
}
