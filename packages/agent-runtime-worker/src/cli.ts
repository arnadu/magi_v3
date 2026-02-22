#!/usr/bin/env node

/**
 * CLI runner for MAGI V3 agent(s).
 *
 * Single-agent mode (Sprint 1):
 *   node dist/cli.js "<task>" ["<system-prompt>"]
 *
 * Multi-agent mode (Sprint 2):
 *   TEAM_CONFIG=<path-to-yaml> node dist/cli.js "<initial-task>" [--step]
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY  required
 *   MODEL              optional — model id (default: claude-sonnet-4-6)
 *   TEAM_CONFIG        optional — path to team config YAML (enables multi-agent mode)
 *   MONGODB_URI        optional — enables persistence (single-agent only in Sprint 2)
 *   SESSION_ID         optional — stable session id for resumption (single-agent only)
 *   AGENT_WORKDIR      optional — working directory for file tools (default: cwd)
 *
 * Flags:
 *   --step             pause after each agent run (multi-agent mode only)
 */

import { randomUUID } from "node:crypto";
import { loadTeamConfig } from "@magi/agent-config";
import { config as dotenvConfig } from "dotenv";

// Load .env from the project root before reading any env vars.
dotenvConfig({ quiet: true });

import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "@mariozechner/pi-ai";
import { createMongoRepository, InMemoryConversationRepository } from "./db.js";
import { runInnerLoop } from "./loop.js";
import {
	createMongoMailboxRepository,
	InMemoryMailboxRepository,
} from "./mailbox.js";
import { InMemoryMentalMapRepository } from "./mental-map.js";
import { anthropicModel, CLAUDE_SONNET } from "./models.js";
import { runOrchestrationLoop } from "./orchestrator.js";
import { createFileTools } from "./tools.js";

const DEFAULT_SYSTEM_PROMPT =
	"You are a helpful AI agent. Complete the given task using the available tools. " +
	"When you are finished, summarise what you did.";

// ---------------------------------------------------------------------------
// Verbose message logging
// ---------------------------------------------------------------------------

/**
 * Print a human-readable summary of a single inner-loop message.
 * prefix is prepended to every line (e.g. "  [lead] " in multi-agent mode).
 */
function logMessage(msg: Message, prefix = ""): void {
	if (msg.role === "user") return; // task is already printed in the header
	if (msg.role === "assistant") {
		for (const block of (msg as AssistantMessage).content) {
			if (block.type === "text" && block.text.trim()) {
				console.log(`${prefix}[assistant] ${block.text.trim()}`);
			} else if (block.type === "toolCall") {
				const args = JSON.stringify(block.arguments);
				const preview = args.length > 120 ? `${args.slice(0, 120)}…` : args;
				console.log(`${prefix}→ ${block.name}(${preview})`);
			}
		}
	} else {
		const tr = msg as ToolResultMessage;
		const text = tr.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("")
			.trim();
		const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
		console.log(`${prefix}← ${tr.toolName}: ${preview}`);
	}
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

function getModel() {
	const modelId = process.env.MODEL ?? "claude-sonnet-4-6";
	return {
		modelId,
		model:
			modelId === "claude-sonnet-4-6" ? CLAUDE_SONNET : anthropicModel(modelId),
	};
}

function makeAbortController(): AbortController {
	const ac = new AbortController();
	process.on("SIGINT", () => {
		console.log("\n[cli] Interrupted — aborting...");
		ac.abort();
	});
	return ac;
}

// ---------------------------------------------------------------------------
// Multi-agent mode
// ---------------------------------------------------------------------------

async function runMultiAgent(
	teamConfigPath: string,
	initialTask: string,
	step: boolean,
): Promise<void> {
	const teamConfig = loadTeamConfig(teamConfigPath);
	const { modelId, model } = getModel();
	const workdir = process.env.AGENT_WORKDIR ?? process.cwd();

	const mongoUri = process.env.MONGODB_URI;
	const mailboxRepo = mongoUri
		? await createMongoMailboxRepository(mongoUri, teamConfig.mission.id)
		: new InMemoryMailboxRepository();
	const mentalMapRepo = new InMemoryMentalMapRepository();

	const leadAgent = teamConfig.agents[0];
	if (!leadAgent) throw new Error("Team config has no agents");

	console.log(
		`Mission:  ${teamConfig.mission.name} (${teamConfig.mission.id})`,
	);
	console.log(`Model:    ${modelId}`);
	console.log(`Workdir:  ${workdir}`);
	console.log(`Agents:   ${teamConfig.agents.map((a) => a.name).join(", ")}`);
	console.log(`Step:     ${step}`);
	console.log(`Task:     ${initialTask}`);
	console.log(`\n--- Starting mission ---\n`);

	// Seed the lead agent's inbox with the initial task.
	await mailboxRepo.post({
		missionId: teamConfig.mission.id,
		from: "user",
		to: [leadAgent.id],
		subject: "Initial task",
		body: initialTask,
	});

	const ac = makeAbortController();

	await runOrchestrationLoop(
		{
			teamConfig,
			mailboxRepo,
			mentalMapRepo,
			model,
			workdir,
			step,
			onAgentMessage: (agentId, msg) => logMessage(msg, `  [${agentId}] `),
		},
		ac.signal,
	);
}

// ---------------------------------------------------------------------------
// Single-agent mode (Sprint 1, unchanged)
// ---------------------------------------------------------------------------

async function runSingleAgent(
	task: string,
	systemPrompt: string,
): Promise<void> {
	const { modelId, model } = getModel();

	const mongoUri = process.env.MONGODB_URI;
	const repository = mongoUri
		? await createMongoRepository(mongoUri)
		: new InMemoryConversationRepository();

	const sessionId = process.env.SESSION_ID ?? randomUUID();
	const workdir = process.env.AGENT_WORKDIR ?? process.cwd();
	const tools = createFileTools(workdir);

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

	const ac = makeAbortController();

	const { turnCount } = await runInnerLoop({
		model,
		systemPrompt,
		task,
		tools,
		signal: ac.signal,
		previousMessages: isResume ? previousMessages : undefined,
		onMessage: async (msg: Message, allMessages: Message[]) => {
			await repository.save(sessionId, allMessages);
			logMessage(msg);
		},
	});

	console.log(`\n--- Done in ${turnCount} turn(s) ---\n`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const rawArgs = process.argv.slice(2);
	const args = rawArgs.filter((a) => !a.startsWith("--"));
	const flags = new Set(rawArgs.filter((a) => a.startsWith("--")));

	if (args.length === 0 || flags.has("--help")) {
		console.error(
			"Usage:\n" +
				"  Single-agent: cli <task> [system-prompt]\n" +
				"  Multi-agent:  TEAM_CONFIG=<yaml> cli <task> [--step]\n\n" +
				"Env vars: ANTHROPIC_API_KEY (required), MODEL, TEAM_CONFIG, " +
				"MONGODB_URI, SESSION_ID, AGENT_WORKDIR",
		);
		process.exit(1);
	}

	if (!process.env.ANTHROPIC_API_KEY) {
		console.error("Error: ANTHROPIC_API_KEY environment variable is required");
		process.exit(1);
	}

	const teamConfigPath = process.env.TEAM_CONFIG;

	if (teamConfigPath) {
		await runMultiAgent(teamConfigPath, args[0], flags.has("--step"));
	} else {
		await runSingleAgent(args[0], args[1] ?? DEFAULT_SYSTEM_PROMPT);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
