/**
 * Integration tests — require ANTHROPIC_API_KEY in environment or .env file.
 * Vitest loads .env automatically, so set the key there for local development.
 *
 * Run:
 *   npx vitest run packages/agent-runtime-worker/tests/loop.integration.test.ts
 *
 * Requires setup-dev.sh to have been run (pool user magi-w1 must exist).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { runInnerLoop } from "../src/loop.js";
import { CLAUDE_SONNET, parseModel } from "../src/models.js";
import { createFileTools } from "../src/tools.js";

const model = process.env.MODEL ? parseModel(process.env.MODEL) : CLAUDE_SONNET;

const POOL_USER = "magi-w1";

function printMessages(messages: Message[]): void {
	for (const msg of messages) {
		if (msg.role === "user") {
			console.log(`[user] ${msg.content}`);
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
			console.log(`[tool:${tr.toolName}] ${text}`);
		}
	}
}

describe("integration: real LLM", () => {
	it("finds a file containing HELLO WORLD and appends GOODBYE", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "magi-int-"));

		// Set ACLs before writing the file so greeting.txt inherits the default
		// ACL (magi-w1 gets rwx on new files). No -R flag: the dir is empty here.
		spawnSync("setfacl", ["-m", `u:${POOL_USER}:rwx`, tmpDir]);
		spawnSync("setfacl", ["-d", "-m", `u:${POOL_USER}:rwx`, tmpDir]);

		writeFileSync(join(tmpDir, "greeting.txt"), "HELLO WORLD\n", "utf-8");

		try {
			const { messages, turnCount } = await runInnerLoop({
				model,
				getSystemPrompt: () =>
					"You are a helpful agent. Complete the given task using the available tools. When finished, confirm what you did.",
				task: 'Find the file in the current working directory that contains the string "HELLO WORLD". Edit this file and add a line with the word GOODBYE.',
				tools: createFileTools(tmpDir, {
					agentId: "loop-test",
					permittedPaths: [tmpDir],
					linuxUser: POOL_USER,
				}),
			});

			printMessages(messages);

			const content = readFileSync(join(tmpDir, "greeting.txt"), "utf-8");
			expect(content).toContain("HELLO WORLD");
			expect(content.toUpperCase()).toContain("GOODBYE");

			// Sanity: the agent should have taken at least one tool-use turn
			expect(turnCount).toBeGreaterThanOrEqual(1);

			// Last message should be an assistant summary
			const last = messages[messages.length - 1];
			expect(last.role).toBe("assistant");
		} finally {
			rmSync(tmpDir, { recursive: true });
		}
	}, 120_000); // 2 minute timeout — real LLM + tool execution
});
