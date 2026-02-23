import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Model, UserMessage } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
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

const DEFAULT_MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image
/** Scale factor when rendering PDF pages to PNG. 1.5 ≈ 108 DPI — good for vision. */
const PDF_RENDER_SCALE = 1.5;

/**
 * MIME types accepted by the vision LLM for auto-description.
 * SVG and AVIF are excluded — Anthropic's vision API does not accept them.
 */
const VISION_MIMES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
]);

/**
 * Prompt used when automatically describing images during a FetchUrl call.
 * Kept brief so the LLM returns a compact 2-4 sentence summary rather than
 * an exhaustive description. Agents can use InspectImage for detailed queries.
 */
const AUTO_DESCRIBE_PROMPT =
	"Briefly describe what this image shows. " +
	"Focus on key information, visible text, charts, diagrams, or notable visual elements. " +
	"Two to four sentences.";

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
	for (const [mime, ext] of Object.entries(MIME_TO_EXT)) {
		if (lower.endsWith(`.${ext}`)) return mime;
	}
	return "text/html";
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
 * the request fails. Returns bytes + resolved MIME type for vision use.
 */
async function fetchImage(
	imgUrl: string,
	signal?: AbortSignal,
): Promise<{ bytes: Buffer; ext: string; mimeType: string } | null> {
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
		const cleanMime = mimeType.split(";")[0].trim();
		const ext = MIME_TO_EXT[cleanMime] ?? extFromPath(parsed.pathname);
		return { bytes, ext, mimeType: cleanMime };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Vision auto-description
// ---------------------------------------------------------------------------

/**
 * Call the vision LLM for a brief auto-description of an image.
 *
 * Non-fatal: returns undefined if the model lacks image capability, the MIME
 * type is not accepted by the vision API, or the call fails for any reason.
 * Callers continue without a description rather than failing.
 */
async function autoDescribeImage(
	bytes: Buffer,
	mimeType: string,
	model: Model<string>,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (!model.input.includes("image")) return undefined;
	if (!VISION_MIMES.has(mimeType)) return undefined;

	try {
		const msg: UserMessage = {
			role: "user",
			timestamp: Date.now(),
			content: [
				{ type: "text", text: AUTO_DESCRIBE_PROMPT },
				{ type: "image", data: bytes.toString("base64"), mimeType },
			],
		};
		const response = await completeSimple(
			model,
			{ messages: [msg] },
			{ signal },
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			return undefined;
		}
		const text = response.content
			.filter((b) => b.type === "text")
			.map((b) => (b as { type: "text"; text: string }).text)
			.join("\n")
			.trim();
		return text || undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Direct image processing
// ---------------------------------------------------------------------------

/**
 * Handle FetchUrl called on a direct image URL (mimeType starts with "image/").
 * Saves the image and its auto-description as an artifact.
 */
async function processDirectImage(
	bytes: Buffer,
	mimeType: string,
	workdir: string,
	rawUrl: string,
	model: Model<string>,
	signal?: AbortSignal,
): Promise<ToolResult> {
	const cleanMime = mimeType.split(";")[0].trim();
	const ext = MIME_TO_EXT[cleanMime] ?? extFromPath(new URL(rawUrl).pathname);
	const filename = `image.${ext}`;

	const description = await autoDescribeImage(bytes, cleanMime, model, signal);
	const contentText = description
		? `# Image\n\n${description}`
		: `# Image\n\n(Visual description unavailable — use InspectImage for analysis.)`;

	const artifactId = generateArtifactId(rawUrl);
	const meta: ArtifactMeta = {
		"@type": "ImageObject",
		id: artifactId,
		name: filename,
		url: rawUrl,
		dateCreated: new Date().toISOString(),
		encodingFormat: cleanMime,
		images: [filename],
	};

	try {
		await saveArtifact(
			workdir,
			artifactId,
			[
				{ name: "content.md", content: contentText },
				{ name: filename, content: bytes },
			],
			meta,
		);
	} catch (e) {
		return toolErr(
			`FetchUrl: failed to save image artifact — ${(e as Error).message}`,
		);
	}

	const lines = [
		`Fetched image: ${rawUrl}`,
		`Artifact id: ${artifactId}`,
		`  artifacts/${artifactId}/${filename}`,
		`  artifacts/${artifactId}/content.md`,
		"",
		`Use \`cat artifacts/${artifactId}/content.md\` to read the auto-description.`,
		`Use InspectImage with path "artifacts/${artifactId}/${filename}" for a focused analysis.`,
	];
	return ok(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// PDF processing
// ---------------------------------------------------------------------------

/**
 * Extract text and render pages from a PDF using mupdf.
 * Each page's rendered PNG is auto-described and the description is embedded
 * directly after the page's extracted text in content.md.
 */
async function processPdf(
	bytes: Buffer,
	workdir: string,
	rawUrl: string,
	model: Model<string>,
	signal?: AbortSignal,
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
		let pageSection = `## Page ${i + 1}`;
		if (pageText) pageSection += `\n\n${pageText}`;

		// Page render → PNG + auto-description embedded inline
		try {
			const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);
			const pngBytes = Buffer.from(pixmap.asPNG());
			const filename = `page-${i + 1}.png`;
			imageFiles.push({ name: filename, content: pngBytes });
			imageRelPaths.push(filename);

			const description = await autoDescribeImage(
				pngBytes,
				"image/png",
				model,
				signal,
			);
			if (description) {
				pageSection += `\n\n**Page visual:** ${description}`;
			}
		} catch {
			// Non-fatal: skip page render on error
		}

		textParts.push(pageSection);
	}

	const contentText =
		textParts.join("\n\n---\n\n") || "(No content extracted from PDF)";

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
		`  artifacts/${artifactId}/content.md  (${contentText.length} chars, ${pageCount} pages, visual descriptions included)`,
		...imageRelPaths.map((p) => `  artifacts/${artifactId}/${p}`),
		"",
		`Use \`cat artifacts/${artifactId}/content.md\` to read extracted text and page descriptions.`,
		`Use InspectImage on a page path for a focused follow-up question.`,
	];

	return ok(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create the FetchUrl tool.
 *
 * Fetches a URL and saves content as an artifact under
 * `{workdir}/artifacts/{id}/`. Image descriptions are automatically generated
 * and embedded in content.md — the agent does not need to call InspectImage
 * for a basic overview. InspectImage remains available for focused questions.
 *
 * Supported content types:
 *   HTML   — Readability text + embedded images downloaded. Each image is
 *             auto-described and descriptions appended as an "## Images" section.
 *   PDF    — mupdf text extraction + per-page PNG render. Each page's visual
 *             description is embedded right after its extracted text.
 *   image  — image saved + auto-described; description written to content.md.
 *   plain text — saved as-is.
 */
export function createFetchUrlTool(
	workdir: string,
	model: Model<string>,
): MagiTool {
	return {
		name: "FetchUrl",
		description:
			"Fetch a URL and save its content as an artifact in artifacts/. " +
			"Supports HTML (article text + images), PDF (text + per-page visuals), " +
			"and direct image URLs. " +
			"Image descriptions are auto-generated and embedded in content.md so you " +
			"can read everything with a single `cat artifacts/<id>/content.md`. " +
			"Use InspectImage for focused follow-up questions about a specific image.",
		parameters: Type.Object({
			url: Type.String({
				description: "URL to fetch (http://, https://, or file://)",
			}),
			download_images: Type.Optional(
				Type.Boolean({
					description:
						"Download and describe <img> images from HTML pages (default: true)",
				}),
			),
			max_images: Type.Optional(
				Type.Number({
					description: `Maximum number of images to download and describe (default: ${DEFAULT_MAX_IMAGES}, max: 10). Increase only when a page's visual content is central to the task.`,
				}),
			),
		}),

		async execute(_id, args, signal) {
			const rawUrl = args.url as string;
			const downloadImages = args.download_images !== false;
			const maxImages = Math.min(
				Math.max(1, (args.max_images as number | undefined) ?? DEFAULT_MAX_IMAGES),
				10,
			);

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
				return processPdf(bytes, workdir, rawUrl, model, signal);
			}

			if (mimeType.startsWith("image/")) {
				return processDirectImage(
					bytes,
					mimeType,
					workdir,
					rawUrl,
					model,
					signal,
				);
			}

			if (
				!mimeType.startsWith("text/html") &&
				!mimeType.startsWith("text/plain")
			) {
				return toolErr(
					`FetchUrl: unsupported content type "${mimeType}". Supported: HTML, PDF, images, plain text.`,
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

			const articleText = article?.textContent?.trim() || html;

			// --- Download images and auto-describe each one -------------------
			const imageFiles: FileEntry[] = [];
			const imageRelPaths: string[] = [];
			const imageDescriptions: string[] = [];

			if (downloadImages) {
				// Query images from Readability's cleaned article HTML, not the full
				// document — this filters out nav/sidebar/footer decorative icons.
				// Fall back to the full document if Readability returned nothing.
				const articleDom = article?.content
					? new JSDOM(article.content, { url: parsedUrl.toString() })
					: dom;
				const imgEls = Array.from(
					articleDom.window.document.querySelectorAll("img"),
				).slice(0, maxImages);

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

					const description = await autoDescribeImage(
						result.bytes,
						result.mimeType,
						model,
						signal,
					);
					imageDescriptions.push(description ?? "");
					idx++;
				}
			}

			// --- Assemble content.md -------------------------------------------
			// Article text first, then an "## Images" section if images were found.
			let contentText = articleText;
			if (imageRelPaths.length > 0) {
				const imageSections = imageRelPaths.map((filename, i) => {
					const desc = imageDescriptions[i];
					return desc
						? `### ${filename}\n${desc}`
						: `### ${filename}\n(Visual description unavailable — use InspectImage for analysis.)`;
				});
				contentText += `\n\n## Images\n\n${imageSections.join("\n\n")}`;
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
			const hasDescriptions = imageDescriptions.some((d) => d);
			const lines = [
				`Fetched: ${rawUrl}`,
				`Artifact id: ${artifactId}`,
				`  artifacts/${artifactId}/content.md  (${contentText.length} chars${imageRelPaths.length > 0 ? `, including ${imageRelPaths.length} image description${imageRelPaths.length !== 1 ? "s" : ""}` : ""})`,
				...imageRelPaths.map((p) => `  artifacts/${artifactId}/${p}`),
				"",
				`Use \`cat artifacts/${artifactId}/content.md\` to read the article${hasDescriptions ? " and image descriptions" : ""}.`,
			];
			if (imageRelPaths.length > 0) {
				lines.push(
					`Use InspectImage for focused follow-up questions about a specific image.`,
				);
			}

			return ok(lines.join("\n"));
		},
	};
}
