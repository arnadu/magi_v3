/**
 * Deterministic unit test for the FetchUrl → document-processor wiring
 * (Sprint 25 phase 2c dedup).
 *
 * No network and no SSRF exemption in source: we stub the two boundaries in the
 * test only — global `fetch` (returns fixture bytes) and `isPrivateHost` (so a
 * public test URL is allowed). Production SSRF stays absolute. A text-only model
 * means `createDescribeImage` short-circuits with no vision/LLM call, keeping the
 * test fully offline. This exercises the real execute() path that the
 * fetch-*.integration tests cannot (their 127.0.0.1 server is SSRF-blocked).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Allow any host and stub the network layer (no production change). Hoisted
// by Vitest. safe-http.ts has its own tests against a real local server.
vi.mock("../src/ssrf.js", () => ({
	isPrivateHost: vi.fn(async () => false),
}));
vi.mock("../src/safe-http.js", () => ({ safeGet: vi.fn() }));

import { safeGet } from "../src/safe-http.js";
import { createFetchUrlTool } from "../src/tools/fetch-url.js";

const DOCS = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"testdata",
	"documents",
);

// Text-only model → createDescribeImage returns undefined without an LLM call.
const TEXT_MODEL = {
	id: "test-text",
	name: "test-text",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
} as unknown as Model<string>;

/** Stub safeGet to return given bytes + content-type for any URL. */
function stubFetch(bytes: Buffer, contentType: string): void {
	vi.mocked(safeGet).mockImplementation(async (input) => ({
		status: 200,
		headers: { "content-type": contentType },
		bytes,
		finalUrl: typeof input === "string" ? new URL(input) : input,
	}));
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "magi-fetchurl-"));
});
afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

function resultText(r: { content: { type: string; text?: string }[] }): string {
	return r.content.map((b) => b.text ?? "").join("");
}

describe("FetchUrl → document-processor wiring", () => {
	it("routes a fetched PDF through processBuffer", async () => {
		stubFetch(readFileSync(join(DOCS, "test-pdf.pdf")), "application/pdf");
		const tool = createFetchUrlTool(TEXT_MODEL, dir);

		const r = await tool.execute("call-1", {
			url: "https://example.com/report.pdf",
		});
		expect(r.isError ?? false).toBe(false);
		const text = resultText(r);
		expect(text).toContain("Artifact id");
		expect(text).toContain("(pdf,"); // format surfaced by fetchSummary

		// Extract the artifact id and read the produced content.md.
		const id = text.match(/Artifact id: (\S+)/)?.[1];
		expect(id).toBeTruthy();
		const md = await readFile(
			join(dir, "artifacts", id as string, "content.md"),
			"utf8",
		);
		expect(md).toContain("Page 1");
		// Source PDF retained for deferred-page recovery (a processBuffer behavior).
		await expect(
			readFile(join(dir, "artifacts", id as string, "report.pdf")),
		).resolves.toBeInstanceOf(Buffer);
	});

	it("routes a fetched image through processBuffer", async () => {
		stubFetch(readFileSync(join(DOCS, "dog.png")), "image/png");
		const tool = createFetchUrlTool(TEXT_MODEL, dir);

		const r = await tool.execute("call-2", {
			url: "https://example.com/dog.png",
		});
		expect(r.isError ?? false).toBe(false);
		const id = resultText(r).match(/Artifact id: (\S+)/)?.[1];
		expect(id).toBeTruthy();
		// The image file is saved for follow-up InspectImage.
		await expect(
			readFile(join(dir, "artifacts", id as string, "image.png")),
		).resolves.toBeInstanceOf(Buffer);
	});

	it("still rejects unsupported content types", async () => {
		stubFetch(Buffer.from("noop"), "application/x-tar");
		const tool = createFetchUrlTool(TEXT_MODEL, dir);
		const r = await tool.execute("call-3", {
			url: "https://example.com/archive.tar",
		});
		expect(r.isError).toBe(true);
		expect(resultText(r)).toContain("unsupported content type");
	});

	it("saves an HTML article with a provenance banner and its images", async () => {
		const png = readFileSync(join(DOCS, "dog.png"));
		const html =
			"<html><head><title>Gold today</title></head><body><article>" +
			"<h1>Gold today</h1><p>Gold rose on central-bank buying. ".repeat(20) +
			'</p><img src="/img/chart.png"><img src="https://cdn.example.com/missing.png">' +
			"</article></body></html>";
		vi.mocked(safeGet).mockImplementation(async (input) => {
			const url = typeof input === "string" ? new URL(input) : input;
			if (url.pathname.endsWith("chart.png"))
				return {
					status: 200,
					headers: { "content-type": "image/png" },
					bytes: png,
					finalUrl: url,
				};
			if (url.pathname.endsWith("missing.png"))
				return {
					status: 404,
					headers: {},
					bytes: Buffer.alloc(0),
					finalUrl: url,
				};
			return {
				status: 200,
				headers: { "content-type": "text/html; charset=utf-8" },
				bytes: Buffer.from(html),
				finalUrl: url,
			};
		});
		const tool = createFetchUrlTool(TEXT_MODEL, dir);
		const r = await tool.execute("call-4", {
			url: "https://example.com/news/gold",
		});
		expect(r.isError ?? false).toBe(false);
		const text = resultText(r);
		expect(text).toContain("including 1 image description");
		const id = text.match(/Artifact id: (\S+)/)?.[1] as string;
		const md = await readFile(join(dir, "artifacts", id, "content.md"), "utf8");
		expect(md).toMatch(
			/^> Fetched from https:\/\/example\.com\/news\/gold on /,
		);
		expect(md).toContain("untrusted content");
		expect(md).toContain("central-bank buying");
		expect(md).toContain("### image-0.png");
		expect(md).toContain("Visual description unavailable");
		expect(md).toContain("1 image could not be fetched");
		await expect(
			readFile(join(dir, "artifacts", id, "image-0.png")),
		).resolves.toBeInstanceOf(Buffer);
	});

	it("skips images when download_images is false", async () => {
		vi.mocked(safeGet).mockReset();
		stubFetch(
			Buffer.from(
				'<html><body><p>Plain text page</p><img src="/a.png"></body></html>',
			),
			"text/html",
		);
		const tool = createFetchUrlTool(TEXT_MODEL, dir);
		const r = await tool.execute("call-5", {
			url: "https://example.com/plain",
			download_images: false,
		});
		expect(r.isError ?? false).toBe(false);
		expect(resultText(r)).not.toContain("image description");
		expect(vi.mocked(safeGet)).toHaveBeenCalledTimes(1);
	});

	it("rejects a malformed URL and a non-http protocol before fetching", async () => {
		vi.mocked(safeGet).mockReset();
		const tool = createFetchUrlTool(TEXT_MODEL, dir);
		const bad = await tool.execute("call-6", { url: "not a url" });
		expect(bad.isError).toBe(true);
		expect(resultText(bad)).toContain("invalid URL");
		const ftp = await tool.execute("call-7", { url: "ftp://example.com/x" });
		expect(ftp.isError).toBe(true);
		expect(resultText(ftp)).toContain("unsupported protocol");
		expect(vi.mocked(safeGet)).not.toHaveBeenCalled();
	});
});
