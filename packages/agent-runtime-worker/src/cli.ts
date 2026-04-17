#!/usr/bin/env node

/**
 * Single-run CLI for MAGI V3 agent teams.
 *
 * Runs one orchestration cycle and exits when the inbox is empty.
 * Use daemon.ts for persistent missions. Use cli:post / cli:tail for
 * operator interaction with a running daemon.
 *
 *   TEAM_CONFIG=<path-to-yaml> node dist/cli.js "<initial-task>" [--step]
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY  required
 *   MONGODB_URI        required
 *   TEAM_CONFIG        required — path to team config YAML
 *   MODEL              optional — model id (default: claude-sonnet-4-6)
 *   AGENT_WORKDIR      optional — working directory for file tools (default: cwd)
 *
 * Flags:
 *   --step             pause after each agent run
 */

import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTeamConfig } from "@magi/agent-config";
import { config as dotenvConfig } from "dotenv";

// Load .env from the repo root (two levels up from packages/agent-runtime-worker/).
dotenvConfig({
	path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env"),
	quiet: true,
});

import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "@mariozechner/pi-ai";
import { createMongoConversationRepository } from "./conversation-repository.js";
import { createMongoMailboxRepository } from "./mailbox.js";
import { CLAUDE_HAIKU, CLAUDE_SONNET, parseModel } from "./models.js";
import { connectMongo } from "./mongo.js";
import { runOrchestrationLoop } from "./orchestrator.js";
import { expandAtPaths } from "./user-input.js";
import { WorkspaceManager } from "./workspace-manager.js";

// ---------------------------------------------------------------------------
// Verbose message logging
// ---------------------------------------------------------------------------

function logMessage(msg: Message, agentId?: string): void {
	if (msg.role === "user") return;
	const indent = agentId ? "  " : "";
	const speaker = agentId ?? "assistant";
	if (msg.role === "assistant") {
		for (const block of (msg as AssistantMessage).content) {
			if (block.type === "text" && block.text.trim()) {
				console.log(`${indent}[${speaker}] ${block.text.trim()}`);
			} else if (block.type === "toolCall") {
				const args = JSON.stringify(block.arguments);
				const preview = args.length > 120 ? `${args.slice(0, 120)}…` : args;
				console.log(`${indent}[${speaker}] → ${block.name}(${preview})`);
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
		console.log(`${indent}[${speaker}] ← ${tr.toolName}: ${preview}`);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getModel() {
	const modelId = process.env.MODEL ?? "claude-sonnet-4-6";
	const model =
		modelId === "claude-sonnet-4-6" ? CLAUDE_SONNET : parseModel(modelId);
	const visionModelId = process.env.VISION_MODEL ?? "claude-haiku-4-5-20251001";
	const visionModel =
		visionModelId === "claude-haiku-4-5-20251001" ? CLAUDE_HAIKU
		: visionModelId === "claude-sonnet-4-6" ? CLAUDE_SONNET
		: parseModel(visionModelId);
	return { modelId, model, visionModel };
}

function makeAbortController(): AbortController {
	const ac = new AbortController();
	process.on("SIGINT", () => {
		console.log("\n[cli] Interrupted — exiting...");
		ac.abort();
		process.exit(130);
	});
	return ac;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const rawArgs = process.argv.slice(2);
	const args = rawArgs.filter((a) => !a.startsWith("--"));
	const flags = new Set(rawArgs.filter((a) => a.startsWith("--")));

	const teamConfigPath = process.env.TEAM_CONFIG;
	const mongoUri = process.env.MONGODB_URI;

	if (args.length === 0 || flags.has("--help") || !teamConfigPath) {
		console.error(
			"Usage: TEAM_CONFIG=<yaml> MONGODB_URI=<uri> cli <task> [--step]\n\n" +
				"Env vars: ANTHROPIC_API_KEY (required), MONGODB_URI (required), " +
				"TEAM_CONFIG (required), MODEL, AGENT_WORKDIR",
		);
		process.exit(1);
	}

	if (!process.env.ANTHROPIC_API_KEY) {
		console.error("Error: ANTHROPIC_API_KEY environment variable is required");
		process.exit(1);
	}

	if (!mongoUri) {
		console.error("Error: MONGODB_URI environment variable is required");
		process.exit(1);
	}

	const teamConfig = loadTeamConfig(teamConfigPath);
	const { modelId, model, visionModel } = getModel();
	const workdir = process.env.AGENT_WORKDIR ?? process.cwd();

	// Team skills live beside the YAML: config/teams/<name>/skills/
	const teamSkillsPath = join(
		dirname(teamConfigPath),
		basename(teamConfigPath, ".yaml"),
		"skills",
	);
	const workspaceManager = new WorkspaceManager({
		layout: {
			homeBase: join(workdir, "home"),
			missionsBase: join(workdir, "missions"),
		},
		teamSkillsPath,
	});

	const { client, db } = await connectMongo(mongoUri);
	const mailboxRepo = createMongoMailboxRepository(db, teamConfig.mission.id);
	const conversationRepo = createMongoConversationRepository(db);

	const leadAgent = teamConfig.agents[0];
	if (!leadAgent) throw new Error("Team config has no agents");

	console.log(
		`Mission:  ${teamConfig.mission.name} (${teamConfig.mission.id})`,
	);
	console.log(`Model:    ${modelId}`);
	console.log(`Workdir:  ${workdir}`);
	console.log(
		`Agents:   ${teamConfig.agents.map((a) => a.name ?? a.id).join(", ")}`,
	);
	console.log(`Step:     ${flags.has("--step")}`);
	console.log(`Task:     ${args[0]}`);
	console.log(`\n--- Starting mission ---\n`);

	// Expand any @path tokens in the initial task before posting.
	const initialBody = await expandAtPaths(args[0], workdir);

	await mailboxRepo.post({
		missionId: teamConfig.mission.id,
		from: "user",
		to: [leadAgent.id],
		subject: "Initial task",
		body: initialBody,
	});

	const ac = makeAbortController();

	try {
		await runOrchestrationLoop(
			{
				teamConfig,
				mailboxRepo,
				conversationRepo,
				model,
				visionModel,
				workdir,
				workspaceManager,
				step: flags.has("--step"),
				onAgentMessage: (agentId, msg) => logMessage(msg, agentId),
				teardownOnExit: true,
			},
			ac.signal,
		);
	} finally {
		await client.close();
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
