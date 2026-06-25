import { join } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import { Readability } from "@mozilla/readability";
import { Type } from "@sinclair/typebox";
import { JSDOM } from "jsdom";
import {
	type ArtifactMeta,
	type FileEntry,
	generateArtifactId,
	saveArtifact,
} from "../artifacts.js";
import {
	createDescribeImage,
	type ProcessResult,
	processBuffer,
} from "../document-processor.js";
import { MIME_TO_EXT } from "../mime-types.js";
import { isPrivateHost } from "../ssrf.js";
import type { MagiTool, ToolResult } from "../tools.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_IMAGES = 3;
const DEFAULT_MAX_PDF_PAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image
/** Maximum bytes for the primary fetched resource (HTML, PDF, plain text). */
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Render the FetchUrl result text from a document-processor outcome. PDF and
 * image fetches now go through the shared processor; this preserves FetchUrl's
 * "here is the artifact — cat it / InspectImage it" output contract.
 */
function fetchSummary(
	rawUrl: string,
	res: ProcessResult,
	artifactsDir: string,
): string {
	const artifactPath = join(artifactsDir, "artifacts", res.artifactId);
	return [
		`Fetched: ${rawUrl}`,
		`Artifact id: ${res.artifactId} (${res.format}, ${res.processingStatus})`,
		`  ${res.contentPath}`,
		"",
		`Use Bash: cat "${artifactPath}/content.md"  to read the extracted content.`,
		`Use InspectImage on any saved image/page under ${artifactPath}/ for a focused look.`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(text: string): ToolResult {
	return { content: [{ type: "text", text }] };
}

function toolErr(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

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

/**
 * Fetch raw bytes + Content-Type from an http(s) URL.
 * Rejects responses larger than MAX_RESPONSE_BYTES to prevent OOM.
 */
async function fetchResource(
	url: URL,
	signal?: AbortSignal,
): Promise<{ bytes: Buffer; contentType: string }> {
	const res = await fetch(url.toString(), { signal });
	if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

	const contentLength = Number(res.headers.get("content-length") ?? "0");
	if (contentLength > MAX_RESPONSE_BYTES) {
		throw new Error(
			`Response too large: Content-Length ${contentLength} bytes exceeds ${MAX_RESPONSE_BYTES} byte limit`,
		);
	}

	const contentType =
		res.headers.get("content-type") ?? "application/octet-stream";
	const bytes = Buffer.from(await res.arrayBuffer());

	if (bytes.length > MAX_RESPONSE_BYTES) {
		throw new Error(
			`Response too large: ${bytes.length} bytes exceeds ${MAX_RESPONSE_BYTES} byte limit`,
		);
	}

	return { bytes, contentType };
}

/**
 * Fetch a single image. Returns null if the image exceeds the size limit or
 * the request fails. Returns bytes + resolved MIME type for vision use.
 */
async function fetchImage(
	imgUrl: string,
	signal?: AbortSignal,
	allowedHosts: string[] = [],
): Promise<{ bytes: Buffer; ext: string; mimeType: string } | null> {
	try {
		const parsed = new URL(imgUrl);
		// Only http/https images are fetched — file:// is not permitted.
		if (!["http:", "https:"].includes(parsed.protocol)) return null;
		if (await isPrivateHost(parsed.hostname, allowedHosts)) return null;

		const res = await fetch(imgUrl, { signal });
		if (!res.ok) return null;
		const cl = Number(res.headers.get("content-length") ?? "0");
		if (cl > MAX_IMAGE_BYTES) return null;
		const bytes = Buffer.from(await res.arrayBuffer());
		if (bytes.length > MAX_IMAGE_BYTES) return null;
		const mimeType = res.headers.get("content-type") ?? "image/jpeg";
		const cleanMime = mimeType.split(";")[0].trim();
		const ext = MIME_TO_EXT[cleanMime] ?? extFromPath(parsed.pathname);
		return { bytes, ext, mimeType: cleanMime };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create the FetchUrl tool.
 *
 * Fetches a URL and saves content as an artifact under
 * `{artifactsDir}/artifacts/{id}/`. Image descriptions are automatically
 * generated and embedded in content.md — the agent does not need to call
 * InspectImage for a basic overview. InspectImage remains available for
 * focused questions.
 *
 * The tool always returns absolute paths in its output so agents can
 * reference artifacts regardless of their working directory.
 *
 * Supported content types:
 *   HTML   — Readability text + embedded images downloaded. Each image is
 *             auto-described and descriptions appended as an "## Images" section.
 *   PDF    — mupdf text extraction + per-page PNG render. Each page's visual
 *             description is embedded right after its extracted text.
 *   image  — image saved + auto-described; description written to content.md.
 *   plain text — saved as-is.
 *
 * @param model     LLM used for auto-describing images.
 * @param artifactsDir  Directory under which artifacts/{id}/ folders are created.
 *                      Use identity.sharedDir in multi-agent contexts so all
 *                      agents on the mission can read the same artifacts.
 */
export function createFetchUrlTool(
	model: Model<string>,
	artifactsDir: string,
	// Hosts exempt from the SSRF guard — TEST INFRASTRUCTURE ONLY. Production
	// constructs this tool with no allowedHosts (→ []), so SSRF stays fully
	// enforced. Mirrors tryCreateBrowseWebTool's parameter.
	allowedHosts: string[] = [],
): MagiTool {
	return {
		name: "FetchUrl",
		description:
			"Fetch an http:// or https:// URL and save its content as an artifact. " +
			"Supports HTML (article text + images), PDF (text + per-page visuals), " +
			"and direct image URLs. " +
			"Image descriptions are auto-generated and embedded in content.md. " +
			"The tool returns the absolute path to each saved file — use those paths " +
			"with Bash (cat) or InspectImage directly.",
		parameters: Type.Object({
			url: Type.String({
				description: "URL to fetch (http:// or https://)",
			}),
			download_images: Type.Optional(
				Type.Boolean({
					description:
						"Download and describe <img> images from HTML pages (default: true)",
				}),
			),
			max_images: Type.Optional(
				Type.Number({
					description: `Maximum number of images to download and describe from HTML pages (default: ${DEFAULT_MAX_IMAGES}, max: 10).`,
				}),
			),
			max_pages: Type.Optional(
				Type.Number({
					description: `Maximum number of PDF pages to extract and describe (default: ${DEFAULT_MAX_PDF_PAGES}, max: 20). Increase for longer documents when all pages are needed.`,
				}),
			),
		}),

		async execute(_id, args, signal) {
			const rawUrl = args.url as string;
			const downloadImages = args.download_images !== false;
			const maxImages = Math.min(
				Math.max(
					1,
					(args.max_images as number | undefined) ?? DEFAULT_MAX_IMAGES,
				),
				10,
			);
			const maxPages = Math.min(
				Math.max(
					1,
					(args.max_pages as number | undefined) ?? DEFAULT_MAX_PDF_PAGES,
				),
				20,
			);

			// --- Validate URL --------------------------------------------------
			let parsedUrl: URL;
			try {
				parsedUrl = new URL(rawUrl);
			} catch {
				return toolErr(`FetchUrl: invalid URL "${rawUrl}"`);
			}
			if (!["http:", "https:"].includes(parsedUrl.protocol)) {
				return toolErr(
					`FetchUrl: unsupported protocol "${parsedUrl.protocol}". Use http or https.`,
				);
			}
			if (await isPrivateHost(parsedUrl.hostname, allowedHosts)) {
				return toolErr(
					`FetchUrl: requests to private/internal addresses are not permitted ("${rawUrl}")`,
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

			// Single captioner shared with the document processor (and uploads).
			const describeImage = createDescribeImage(model, signal);

			// --- Route by content type -----------------------------------------
			// PDF and direct images go through the shared document processor so
			// fetched and uploaded files get identical treatment (the describe-now/
			// defer image policy, partial-processing markers, etc.).
			if (mimeType === "application/pdf") {
				const res = await processBuffer(bytes, {
					filename: parsedUrl.pathname.split("/").pop() || "document.pdf",
					mimeType,
					artifactsDir,
					describeImage,
					sourceUrl: rawUrl,
					// Mirror the old FetchUrl knob: render + describe up to max_pages.
					limits: { maxRenderPages: maxPages, maxAutoDescribe: maxPages },
					signal,
				});
				return ok(fetchSummary(rawUrl, res, artifactsDir));
			}

			if (mimeType.startsWith("image/")) {
				const res = await processBuffer(bytes, {
					filename: parsedUrl.pathname.split("/").pop() || "image",
					mimeType,
					artifactsDir,
					describeImage,
					sourceUrl: rawUrl,
					signal,
				});
				return ok(fetchSummary(rawUrl, res, artifactsDir));
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
			const imageEntries: Array<{
				filename: string;
				description: string | null;
			}> = [];
			let imagesFailed = 0;

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
						imagesFailed++;
						continue;
					}

					const result = await fetchImage(imgUrl, signal, allowedHosts);
					if (!result) {
						imagesFailed++;
						continue;
					}

					const filename = `image-${idx}.${result.ext}`;
					imageFiles.push({ name: filename, content: result.bytes });
					const description =
						(await describeImage(result.bytes, result.mimeType)) ?? null;
					imageEntries.push({ filename, description });
					idx++;
				}
			}

			// --- Assemble content.md -------------------------------------------
			// Article text first, then an "## Images" section if images were found.
			let contentText = articleText;
			if (imageEntries.length > 0) {
				const imageSections = imageEntries.map(({ filename, description }) =>
					description
						? `### ${filename}\n${description}`
						: `### ${filename}\n(Visual description unavailable — use InspectImage for analysis.)`,
				);
				contentText += `\n\n## Images\n\n${imageSections.join("\n\n")}`;
			}
			if (imagesFailed > 0) {
				contentText += `\n\n*(${imagesFailed} image${imagesFailed !== 1 ? "s" : ""} could not be fetched — too large, unsupported format, or network error.)*`;
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
				...(imageEntries.length > 0
					? { images: imageEntries.map((e) => e.filename) }
					: {}),
			};

			const files: FileEntry[] = [
				{ name: "content.md", content: contentText },
				...imageFiles,
			];

			try {
				await saveArtifact(artifactsDir, artifactId, files, meta);
			} catch (e) {
				return toolErr(
					`FetchUrl: failed to save artifact — ${(e as Error).message}`,
				);
			}

			// --- Return summary ------------------------------------------------
			const artifactPath = join(artifactsDir, "artifacts", artifactId);
			const hasDescriptions = imageEntries.some((e) => e.description);
			const lines = [
				`Fetched: ${rawUrl}`,
				`Artifact id: ${artifactId}`,
				`  ${artifactPath}/content.md  (${contentText.length} chars${imageEntries.length > 0 ? `, including ${imageEntries.length} image description${imageEntries.length !== 1 ? "s" : ""}` : ""})`,
				...imageEntries.map((e) => `  ${artifactPath}/${e.filename}`),
				"",
				`Use Bash: cat "${artifactPath}/content.md"  to read the article${hasDescriptions ? " and image descriptions" : ""}.`,
			];
			if (imageEntries.length > 0) {
				lines.push(
					`Use InspectImage with the absolute path above for focused follow-up questions about a specific image.`,
				);
			}

			return ok(lines.join("\n"));
		},
	};
}
