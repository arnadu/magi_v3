/**
 * Generated SVG is untrusted (ADR-0035 decision 7): rendering a preview must
 * not run its scripts or fetch anything it references. Needs Playwright's
 * Chromium; skipped where it is not installed (CI's unit job), run by the
 * local pre-push verify.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createPreviewRenderer,
	PREVIEW_MAX_PX,
	previewChromiumPath,
	previewPageHtml,
} from "../src/images/image-preview.js";

const hasChromium = previewChromiumPath() !== undefined;

describe("previewPageHtml", () => {
	it("embeds the image as a data URL in a fixed box", () => {
		const html = previewPageHtml({
			mimeType: "image/svg+xml",
			bytes: Buffer.from("<svg/>"),
		});
		expect(html).toContain("data:image/svg+xml;base64,");
		expect(html).not.toContain("<svg");
		expect(html).toContain(`width:${PREVIEW_MAX_PX}px`);
	});
});

describe.skipIf(!hasChromium)("preview rendering (Chromium)", () => {
	let server: Server;
	let hits: string[];
	let base: string;

	beforeAll(async () => {
		hits = [];
		server = createServer((req, res) => {
			hits.push(req.url ?? "");
			res.end("x");
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterAll(() => new Promise<void>((r) => server.close(() => r())));

	it("renders a hostile SVG to a JPEG without running scripts or loading references", async () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="100" viewBox="0 0 200 100">
<style>@import url("${base}/css");</style>
<script>fetch("${base}/script")</script>
<image href="${base}/image.png" width="10" height="10"/>
<image xlink:href="file:///etc/passwd" width="10" height="10"/>
<rect width="200" height="100" fill="green" onload="fetch('${base}/onload')"/>
</svg>`;
		const render = createPreviewRenderer();
		if (!render) throw new Error("renderer unavailable");
		const [jpeg] = await render([
			{ mimeType: "image/svg+xml", bytes: Buffer.from(svg) },
		]);
		expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
		expect(jpeg.length).toBeGreaterThan(500);
		// Give any stray request time to arrive.
		await new Promise((r) => setTimeout(r, 300));
		expect(hits).toEqual([]);
	}, 60_000);
});
