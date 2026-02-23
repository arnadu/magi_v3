/**
 * Sprint 3 — Integration Test 1 (Gate): FetchUrl + InspectImage
 *
 * A single agent fetches a local HTML page (via file:// URL) that contains an
 * embedded <img src="./cat.jpg">. FetchUrl downloads the image alongside the
 * article text. The agent then calls InspectImage on the downloaded image and
 * reports what it sees. The test asserts that the final report mentions a cat.
 *
 * Run:
 *   npm run test:integration
 * Requires ANTHROPIC_API_KEY in .env.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { runInnerLoop } from "../src/loop.js";
import { CLAUDE_SONNET } from "../src/models.js";
import { createFetchUrlTool } from "../src/tools/fetch-url.js";
import { createInspectImageTool } from "../src/tools/inspect-image.js";
import { createFileTools } from "../src/tools.js";

// ---------------------------------------------------------------------------
// Test assets
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DOCS = join(__dirname, "..", "..", "..", "testdata", "documents");
const HTML_URL = pathToFileURL(join(TEST_DOCS, "with-image.html")).toString();

// ---------------------------------------------------------------------------
// Logging helper (mirrors loop.integration.test.ts)
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

		try {
			const { messages, turnCount } = await runInnerLoop({
				model: CLAUDE_SONNET,
				systemPrompt:
					"You are a research assistant. Use the available tools to complete the task. " +
					"When finished, write a concise summary of what you found.",
				task:
					`Fetch this URL: ${HTML_URL}\n` +
					"After fetching, inspect every image that was downloaded from the page. " +
					"Report: (1) the article title and a one-sentence summary of the text, " +
					"(2) a description of each image you inspected.",
				tools: [
					...createFileTools(workdir),
					createFetchUrlTool(workdir, CLAUDE_SONNET),
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
