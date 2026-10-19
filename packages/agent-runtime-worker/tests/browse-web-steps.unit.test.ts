/** BrowseWeb's browser-free pieces; the browser itself is covered by browse-web.integration. */
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browseResult, validateTarget } from "../src/tools/browse-web.js";
import {
	SessionLog,
	stagehandModelFor,
} from "../src/tools/browse-web-session.js";

const text = (r: { content: Array<{ type: string; text?: string }> }) =>
	r.content.map((c) => c.text ?? "").join("");

describe("stagehandModelFor", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("Anthropic models by id", () => {
		expect(
			stagehandModelFor({
				provider: "anthropic",
				id: "claude-haiku-4-5-20251001",
			} as Model<string>),
		).toBe("anthropic/claude-haiku-4-5-20251001");
	});

	it("OpenRouter models need OPENROUTER_API_KEY and use its endpoint", () => {
		vi.stubEnv("OPENROUTER_API_KEY", "");
		const m = { provider: "openrouter", id: "mistralai/x" } as Model<string>;
		expect(() => stagehandModelFor(m)).toThrow(/OPENROUTER_API_KEY/);
		vi.stubEnv("OPENROUTER_API_KEY", "k");
		expect(stagehandModelFor(m)).toEqual({
			modelName: "mistralai/x",
			apiKey: "k",
			baseURL: "https://openrouter.ai/api/v1",
		});
	});

	it("other providers are refused", () => {
		expect(() =>
			stagehandModelFor({ provider: "google", id: "g" } as Model<string>),
		).toThrow(/does not support/);
	});
});

describe("SessionLog", () => {
	it("appends NDJSON lines, and echoes errors and agent lines", () => {
		const dir = mkdtempSync(join(tmpdir(), "bw-"));
		const log = new SessionLog(dir);
		const out = vi.spyOn(console, "log").mockImplementation(() => {});
		mkdirSync(log.logsDir, { recursive: true });
		log.onStagehandLog({
			level: 1,
			category: "agent",
			message: "clicked",
		} as never);
		log.onStagehandLog({
			level: 2,
			category: "dom",
			message: "quiet",
			id: "7",
		} as never);
		const lines = readFileSync(log.file, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(lines.map((l) => l.message)).toEqual(["clicked", "quiet"]);
		expect(lines[1].id).toBe("7");
		expect(out).toHaveBeenCalledTimes(1);
		out.mockRestore();
	});

	it("a failed write is reported, not thrown", () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		new SessionLog("/nonexistent-dir-for-test").write({ a: 1 });
		expect(err).toHaveBeenCalled();
		err.mockRestore();
	});
});

describe("validateTarget", () => {
	it("no URL means continue on the current page", async () => {
		expect(await validateTarget(undefined, [])).toBeNull();
	});
	it("refuses malformed, non-http and private targets", async () => {
		expect(text((await validateTarget("not a url", [])) as never)).toMatch(
			/invalid URL/,
		);
		expect(
			text((await validateTarget("file:///etc/passwd", [])) as never),
		).toMatch(/only http/);
		expect(
			text((await validateTarget("http://127.0.0.1/", [])) as never),
		).toMatch(/private\/internal/);
	});
	it("accepts a public address", async () => {
		const t = await validateTarget("https://93.184.216.34/page", []);
		expect(t).toBeInstanceOf(URL);
	});
});

describe("browseResult", () => {
	it("marks the content untrusted and lists the artifact files", () => {
		const out = text(
			browseResult({
				url: "https://example.com/",
				host: "example.com",
				title: "",
				summary: "",
				artifactPath: "/s/artifacts/x",
				hasScreenshot: true,
				logFile: "/s/logs/l.ndjson",
			}) as never,
		);
		expect(out).toContain("⚠ UNTRUSTED WEB CONTENT — source: example.com");
		expect(out).toContain("(no title)");
		expect(out).toContain("(no result returned — see content.md)");
		expect(out).toContain("screenshot.png");
	});
});
