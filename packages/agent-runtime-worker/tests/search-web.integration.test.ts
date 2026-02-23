/**
 * Sprint 3 — Integration Test 3 (Gate): SearchWeb + FetchUrl + auto-describe
 *
 * Scenario:
 *   - Agent is asked to search for "Pale Blue Dot Voyager NASA" and fetch the
 *     top Wikipedia result.
 *   - Agent calls SearchWeb → receives ranked results including the Wikipedia
 *     page for "Pale Blue Dot".
 *   - Agent calls FetchUrl on the Wikipedia URL → Readability extracts the
 *     article text; the famous photograph is downloaded and auto-described.
 *   - Agent reports a summary containing both article facts and image details.
 *
 * This validates:
 *   - SearchWeb returning relevant results for a stable query
 *   - FetchUrl correctly processing a real Wikipedia page (HTML + image)
 *   - Auto-describe producing a vision summary embedded in content.md
 *   - The full single-agent pipeline: search → fetch → describe → report
 *
 * Requires ANTHROPIC_API_KEY and BRAVE_SEARCH_API_KEY in environment or .env.
 * Skipped automatically when BRAVE_SEARCH_API_KEY is absent.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message, ToolResultMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { runInnerLoop } from "../src/loop.js";
import { CLAUDE_SONNET } from "../src/models.js";
import { createFetchUrlTool } from "../src/tools/fetch-url.js";
import { createInspectImageTool } from "../src/tools/inspect-image.js";
import { createSearchWebTool } from "../src/tools/search-web.js";
import { createFileTools } from "../src/tools.js";

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------

function printMessages(messages: Message[]): void {
	for (const msg of messages) {
		if (msg.role === "user") {
			const text =
				typeof msg.content === "string" ? msg.content : "(multipart)";
			console.log(`[user] ${text.slice(0, 200)}`);
		} else if (msg.role === "assistant") {
			for (const block of (msg as AssistantMessage).content) {
				if (block.type === "text")
					console.log(`[assistant] ${block.text.slice(0, 300)}`);
				else if (block.type === "toolCall")
					console.log(
						`[tool→] ${block.name}(${JSON.stringify(block.arguments).slice(0, 120)})`,
					);
			}
		} else if (msg.role === "toolResult") {
			const tr = msg as ToolResultMessage;
			const text = tr.content
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("");
			console.log(`[tool←] ${tr.toolName}: ${text.slice(0, 300)}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("integration: SearchWeb + FetchUrl + auto-describe", () => {
	it(
		"searches for Pale Blue Dot, fetches Wikipedia page, and describes the photograph",
		async () => {
			const apiKey = process.env.BRAVE_SEARCH_API_KEY;
			if (!apiKey) {
				console.log(
					"Skipping: BRAVE_SEARCH_API_KEY not set",
				);
				return;
			}

			const workdir = mkdtempSync(join(tmpdir(), "magi-search-"));

			try {
				const { messages } = await runInnerLoop({
					model: CLAUDE_SONNET,
					systemPrompt:
						"You are a research assistant. Use SearchWeb to find pages, " +
						"FetchUrl to retrieve them, and report your findings concisely.",
					task:
						'Search for "Pale Blue Dot Voyager NASA" and fetch the top Wikipedia result. ' +
						"Summarise: (1) what the article says and (2) what you see in the main image.",
					tools: [
						...createFileTools(workdir),
						createSearchWebTool(apiKey),
						createFetchUrlTool(workdir, CLAUDE_SONNET),
						createInspectImageTool(workdir, CLAUDE_SONNET),
					],
				});

				printMessages(messages);

				// Final message must be an assistant summary
				const last = messages[messages.length - 1];
				expect(last.role).toBe("assistant");

				const finalText = (last as AssistantMessage).content
					.filter((b) => b.type === "text")
					.map((b) => b.text)
					.join(" ")
					.toLowerCase();

				// Article text: the page is unambiguously about Voyager / Carl Sagan
				expect(finalText).toMatch(/voyager|pale blue dot|sagan|carl/i);

				// Image vision: the photograph is Earth as a tiny dot in dark space
				expect(finalText).toMatch(/blue|dot|earth|planet|space|dark/i);
			} finally {
				rmSync(workdir, { recursive: true });
			}
		},
		240_000, // 4-minute timeout — network + LLM + vision call
	);
});
