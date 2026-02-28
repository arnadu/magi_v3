/**
 * Sprint 3 — Integration Test 1 (Gate): FetchUrl + InspectImage
 *
 * A single agent fetches a local HTML page (served via a local HTTP server)
 * that contains an embedded <img src="./cat.jpg">. FetchUrl downloads the
 * image alongside the article text. The agent then calls InspectImage on the
 * downloaded image and reports what it sees. The test asserts the final report
 * mentions a cat.
 *
 * Run:
 *   npm run test:integration
 * Requires ANTHROPIC_API_KEY in .env.
 * Requires setup-dev.sh to have been run (pool user magi-w1 must exist).
 */

import { spawnSync } from "node:child_process";
import { createReadStream, mkdtempSync, rmSync, statSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "@mariozechner/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInnerLoop } from "../src/loop.js";
import { CLAUDE_SONNET } from "../src/models.js";
import { createFetchUrlTool } from "../src/tools/fetch-url.js";
import { createInspectImageTool } from "../src/tools/inspect-image.js";
import { createFileTools } from "../src/tools.js";

const POOL_USER = "magi-w1";

// ---------------------------------------------------------------------------
// Local HTTP server for test documents
// ---------------------------------------------------------------------------

const TEST_DOCS = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"testdata",
	"documents",
);

const MIME: Record<string, string> = {
	".html": "text/html",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".pdf": "application/pdf",
};

let server: http.Server;
let baseUrl: string;

beforeAll(
	() =>
		new Promise<void>((resolve) => {
			server = http.createServer((req, res) => {
				const filePath = join(TEST_DOCS, req.url ?? "/");
				try {
					const stat = statSync(filePath);
					const mime =
						MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
					res.writeHead(200, {
						"Content-Type": mime,
						"Content-Length": stat.size,
					});
					createReadStream(filePath).pipe(res);
				} catch {
					res.writeHead(404);
					res.end("Not found");
				}
			});
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address() as { port: number };
				baseUrl = `http://127.0.0.1:${addr.port}`;
				resolve();
			});
		}),
);

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------

function printMessages(messages: Message[]): void {
	for (const msg of messages) {
		if (msg.role === "user") {
			const text =
				typeof msg.content === "string" ? msg.content : "(multipart)";
			console.log(`[user] ${text}`);
		} else if (msg.role === "assistant") {
			for (const block of (msg as AssistantMessage).content) {
				if (block.type === "text") console.log(`[assistant] ${block.text}`);
				else if (block.type === "toolCall")
					console.log(
						`[assistant:toolCall] ${block.name}(${JSON.stringify(block.arguments)})`,
					);
			}
		} else if (msg.role === "toolResult") {
			const tr = msg as ToolResultMessage;
			const text = tr.content
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("");
			console.log(`[tool:${tr.toolName}] ${text.slice(0, 300)}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("integration: FetchUrl + InspectImage", () => {
	it("fetches HTML page, downloads cat image, and describes what it sees", async () => {
		const workdir = mkdtempSync(join(tmpdir(), "magi-fetch-"));

		// Grant the pool user read+write access to the test workdir.
		spawnSync("setfacl", ["-R", "-m", `u:${POOL_USER}:rwx`, workdir]);
		spawnSync("setfacl", ["-d", "-m", `u:${POOL_USER}:rwx`, workdir]);

		const htmlUrl = `${baseUrl}/with-image.html`;

		try {
			const { messages, turnCount } = await runInnerLoop({
				model: CLAUDE_SONNET,
				systemPrompt:
					"You are a research assistant. Use the available tools to complete the task. " +
					"When finished, write a concise summary of what you found.",
				task:
					`Fetch this URL: ${htmlUrl}\n` +
					"After fetching, inspect every image that was downloaded from the page. " +
					"Report: (1) the article title and a one-sentence summary of the text, " +
					"(2) a description of each image you inspected.",
				tools: [
					...createFileTools(workdir, {
						agentId: "fetch-inspect-test",
						permittedPaths: [workdir],
						linuxUser: POOL_USER,
					}),
					createFetchUrlTool(CLAUDE_SONNET, workdir),
					createInspectImageTool(workdir, CLAUDE_SONNET),
				],
			});

			printMessages(messages);

			// The agent must have used at least two tools (FetchUrl + InspectImage)
			expect(turnCount).toBeGreaterThanOrEqual(2);

			// Final message must be an assistant summary
			const last = messages[messages.length - 1];
			expect(last.role).toBe("assistant");

			// The summary must describe the cat image
			const lastText = (last as AssistantMessage).content
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join(" ")
				.toLowerCase();

			expect(lastText).toMatch(/cat|feline|kitten/);
		} finally {
			rmSync(workdir, { recursive: true });
		}
	}, 180_000); // 3 min — LLM + vision call
});
