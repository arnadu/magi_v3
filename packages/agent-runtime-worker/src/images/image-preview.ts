/**
 * Previews of generated images: a JPEG at most PREVIEW_MAX_PX on its longer
 * side, used for critique (a vision call) and the contact sheet. SVG is
 * untrusted output (ADR-0035 decision 7), so every image — SVG or raster —
 * is rendered the same way: as `<img src="data:…">` in a headless Chromium
 * page with JavaScript off, offline, and every non-data request aborted. An
 * SVG loaded as an image never runs scripts or fetches external resources
 * in any case; the page settings are a second layer.
 *
 * One short-lived browser per call, one call at a time per process: the
 * machine's memory is shared with BrowseWeb sessions (#104, #105).
 */

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";

export const PREVIEW_MAX_PX = 1024;
const LAUNCH_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 15_000;

export interface PreviewSource {
	mimeType: string;
	bytes: Buffer;
}

/** Renders previews, one per source, in order; throws when the browser fails. */
export type RenderPreviews = (
	sources: PreviewSource[],
	signal?: AbortSignal,
) => Promise<Buffer[]>;

/** Chromium's path when it is installed, else undefined (previews are then skipped). */
export function previewChromiumPath(): string | undefined {
	try {
		const path = chromium.executablePath();
		return existsSync(path) ? path : undefined;
	} catch {
		return undefined;
	}
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs `fn` after every earlier call has settled: one preview browser per process. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
	const run = queue.then(fn, fn);
	queue = run.catch(() => undefined);
	return run;
}

/** The page that shows one image, scaled to fit the preview box. */
export function previewPageHtml(source: PreviewSource): string {
	const box =
		source.mimeType === "image/svg+xml"
			? `width:${PREVIEW_MAX_PX}px;height:${PREVIEW_MAX_PX}px;object-fit:contain`
			: `max-width:${PREVIEW_MAX_PX}px;max-height:${PREVIEW_MAX_PX}px`;
	// The mime type comes from the image client's allow-list and the data is
	// base64 (no quotes or angle brackets), so neither can break the attribute.
	return `<!doctype html><html><body style="margin:0;background:#fff"><img id="i" alt="" style="display:block;${box}" src="data:${source.mimeType};base64,${source.bytes.toString("base64")}"></body></html>`;
}

/** The default renderer, or undefined when Chromium is not installed. */
export function createPreviewRenderer(): RenderPreviews | undefined {
	const executablePath = previewChromiumPath();
	if (!executablePath) return undefined;
	return (sources, signal) =>
		serialized(async () => {
			const browser = await chromium.launch({
				executablePath,
				headless: true,
				timeout: LAUNCH_TIMEOUT_MS,
				// Playwright passes the daemon's whole environment by default
				// (MONGODB_URI, provider keys); the preview browser needs none of it.
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir() },
			});
			try {
				const context = await browser.newContext({
					javaScriptEnabled: false,
					offline: true,
					viewport: { width: PREVIEW_MAX_PX, height: PREVIEW_MAX_PX },
				});
				await context.route("**/*", (route) =>
					route.request().url().startsWith("data:")
						? route.continue()
						: route.abort(),
				);
				const page = await context.newPage();
				const out: Buffer[] = [];
				for (const source of sources) {
					signal?.throwIfAborted();
					await page.setContent(previewPageHtml(source), {
						timeout: STEP_TIMEOUT_MS,
						waitUntil: "load",
					});
					out.push(
						await page.locator("#i").screenshot({
							type: "jpeg",
							quality: 85,
							timeout: STEP_TIMEOUT_MS,
						}),
					);
				}
				return out;
			} finally {
				await browser.close().catch((e: unknown) => {
					console.error(
						`[image-preview] closing the preview browser failed: ${(e as Error).message} — its process may linger until the daemon exits`,
					);
				});
			}
		});
}
