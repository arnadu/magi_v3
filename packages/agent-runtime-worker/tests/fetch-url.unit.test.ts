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

// Allow any host in this test (no production change). Hoisted by Vitest.
vi.mock("../src/ssrf.js", () => ({
	isPrivateHost: vi.fn(async () => false),
}));

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

/** Stub global fetch to return given bytes + content-type for any URL. */
function stubFetch(bytes: Buffer, contentType: string): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(bytes, {
					status: 200,
					headers: { "content-type": contentType },
				}),
		),
	);
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
});
