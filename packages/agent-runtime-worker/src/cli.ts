#!/usr/bin/env node

/**
 * CLI task runner for the inner loop.
 *
 * Usage:
 *   node dist/cli.js "<task>" ["<system-prompt>"]
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY  required
 *   MODEL              optional — model id (default: claude-sonnet-4-6)
 *   MONGODB_URI        optional — enables persistence and session resumption
 *   SESSION_ID         optional — stable id to resume a previous session
 *   AGENT_WORKDIR      optional — working directory for file tools (default: cwd)
 */

import { randomUUID } from "node:crypto";
import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "@mariozechner/pi-ai";
import { createMongoRepository, InMemoryConversationRepository } from "./db.js";
import { runInnerLoop } from "./loop.js";
import { anthropicModel, CLAUDE_SONNET } from "./models.js";
import { createFileTools } from "./tools.js";

const DEFAULT_SYSTEM_PROMPT =
	"You are a helpful AI agent. Complete the given task using the available tools. " +
	"When you are finished, summarise what you did.";

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length === 0 || args[0] === "--help") {
		console.error(
			"Usage: cli <task> [system-prompt]\n\n" +
				"Env vars: ANTHROPIC_API_KEY (required), MODEL, MONGODB_URI, SESSION_ID, AGENT_WORKDIR\n\n" +
				"Session resumption: set MONGODB_URI and reuse the same SESSION_ID across runs.",
		);
		process.exit(1);
	}

	if (!process.env.ANTHROPIC_API_KEY) {
		console.error("Error: ANTHROPIC_API_KEY environment variable is required");
		process.exit(1);
	}

	const task = args[0];
	const systemPrompt = args[1] ?? DEFAULT_SYSTEM_PROMPT;

	const modelId = process.env.MODEL ?? "claude-sonnet-4-6";
	const model =
		modelId === "claude-sonnet-4-6" ? CLAUDE_SONNET : anthropicModel(modelId);

	const mongoUri = process.env.MONGODB_URI;
	const repository = mongoUri
		? await createMongoRepository(mongoUri)
		: new InMemoryConversationRepository();

	const sessionId = process.env.SESSION_ID ?? randomUUID();
	const workdir = process.env.AGENT_WORKDIR ?? process.cwd();
	const tools = createFileTools(workdir);

	// Load prior conversation if resuming a session.
	const previousMessages = await repository.load(sessionId);
	const isResume = previousMessages.length > 0;

	console.log(`Session:  ${sessionId}${isResume ? " (resuming)" : ""}`);
	console.log(`Model:    ${modelId}`);
	console.log(`Workdir:  ${workdir}`);
	if (isResume) {
		console.log(
			`History:  ${previousMessages.length} message(s) from previous run`,
		);
	}
	console.log(`Task:     ${task}`);
	console.log(`\n--- Running ---\n`);

	const { messages, turnCount } = await runInnerLoop({
		model,
		systemPrompt,
		task,
		tools,
		previousMessages: isResume ? previousMessages : undefined,
		onMessage: async (msg: Message, allMessages: Message[]) => {
			// Persist the full conversation immediately on every new message.
			await repository.save(sessionId, allMessages);
			const label =
				msg.role === "user"
					? "[user]"
					: msg.role === "assistant"
						? "[assistant]"
						: `[tool:${(msg as ToolResultMessage).toolName}]`;
			console.log(label);
		},
	});

	console.log(`\n--- Done in ${turnCount} turn(s) ---\n`);

	// Print the last assistant message.
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const block of (msg as AssistantMessage).content) {
				if (block.type === "text") process.stdout.write(`${block.text}\n`);
			}
			break;
		}
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
