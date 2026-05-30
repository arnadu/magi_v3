#!/usr/bin/env node

/**
 * Dump llmCallLog data for a mission to CSV on stdout.
 * Pipe into scripts/analyze-tokens.py for a formatted report.
 *
 * Usage:
 *   MISSION_ID=<id> MONGODB_URI=<uri> node dist/cli-analyze-dump.js
 *
 * Environment variables:
 *   MISSION_ID    required
 *   MONGODB_URI   required (or set in .env)
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({
	path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env"),
	quiet: true,
});

import { connectMongo } from "./mongo.js";

async function main(): Promise<void> {
	const mongoUri = process.env.MONGODB_URI;
	if (!mongoUri) {
		process.stderr.write("Error: MONGODB_URI is required\n");
		process.exit(1);
	}
	const missionId = process.env.MISSION_ID;
	if (!missionId) {
		process.stderr.write("Error: MISSION_ID is required\n");
		process.exit(1);
	}

	const { client, db } = await connectMongo(mongoUri);
	try {
		const col = db.collection("llmCallLog");
		const projection = {
			agentId: 1,
			turnNumber: 1,
			isReflection: 1,
			savedAt: 1,
			"usage.inputTokens": 1,
			"usage.outputTokens": 1,
			"usage.cacheReadTokens": 1,
			"usage.cacheWriteTokens": 1,
			"usage.cost.totalCostUsd": 1,
			"output.message.content": 1,
			"output.stopReason": 1,
		};

		const cursor = col
			.find({ missionId }, { projection })
			.sort({ agentId: 1, turnNumber: 1, savedAt: 1 });

		let count = 0;
		process.stdout.write(
			"agent_id,turn_number,is_reflection,saved_at,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,stop_reason,tools_called,bash_commands\n",
		);

		for await (const doc of cursor) {
			const content = (doc.output?.message?.content ?? []) as Array<{
				type: string;
				name?: string;
				arguments?: Record<string, unknown>;
			}>;
			const toolCalls = content.filter((b) => b.type === "toolCall");
			const tools = toolCalls.map((b) => b.name ?? "").join("|");
			const bashCmds = toolCalls
				.filter((b) => b.name === "Bash")
				.map((b) => extractBashVerb(String(b.arguments?.command ?? "")))
				.filter(Boolean)
				.join("|");

			const row = [
				escapeCsv(doc.agentId ?? ""),
				String(doc.turnNumber ?? 0),
				String(doc.isReflection ?? false),
				doc.savedAt instanceof Date
					? doc.savedAt.toISOString()
					: String(doc.savedAt ?? ""),
				String(doc.usage?.inputTokens ?? 0),
				String(doc.usage?.outputTokens ?? 0),
				String(doc.usage?.cacheReadTokens ?? 0),
				String(doc.usage?.cacheWriteTokens ?? 0),
				String(doc.usage?.cost?.totalCostUsd ?? 0),
				escapeCsv(doc.output?.stopReason ?? ""),
				escapeCsv(tools),
				escapeCsv(bashCmds),
			].join(",");

			process.stdout.write(`${row}\n`);
			count++;
		}

		process.stderr.write(
			`[cli:analyze-dump] Exported ${count} rows for mission ${missionId}\n`,
		);
	} finally {
		await client.close();
	}
}

/**
 * Return the command verb (first meaningful word) of a Bash command string.
 * Skips blank lines and comment lines; strips common wrappers (sudo, python3, …)
 * so the actual executable name is returned.  Returns "" for empty/comment-only scripts.
 */
function extractBashVerb(cmd: string): string {
	const SKIP = new Set([
		"sudo",
		"env",
		"bash",
		"sh",
		"magi-python3",
		"python3",
		"python",
	]);
	for (const rawLine of cmd.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const words = line.split(/\s+/);
		let i = 0;
		while (
			i < words.length &&
			(SKIP.has(words[i]) || words[i].startsWith("-") || words[i].includes("="))
		) {
			i++;
		}
		if (i < words.length) {
			const w = words[i];
			// Strip path prefix (e.g. /usr/bin/grep → grep)
			return w.split("/").pop() ?? w;
		}
	}
	return "";
}

function escapeCsv(value: string): string {
	if (value.includes(",") || value.includes('"') || value.includes("\n")) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

main().catch((e: unknown) => {
	process.stderr.write(
		`[cli:analyze-dump] Fatal: ${(e as Error).message}\n${(e as Error).stack ?? ""}\n`,
	);
	process.exit(1);
});
