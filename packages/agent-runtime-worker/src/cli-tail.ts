#!/usr/bin/env node

/**
 * Watch the mailbox Change Stream and print messages as they arrive.
 *
 * Usage:
 *   TEAM_CONFIG=<yaml> MONGODB_URI=<uri> node dist/cli-tail.js [--all]
 *
 * --all    Show all inter-agent messages, not just those addressed to "user".
 *
 * Environment variables:
 *   MONGODB_URI   required
 *   TEAM_CONFIG   required — used to resolve missionId
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTeamConfig } from "@magi/agent-config";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({
	path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env"),
	quiet: true,
});

import { connectMongo } from "./mongo.js";

async function main(): Promise<void> {
	const mongoUri = process.env.MONGODB_URI;
	const teamConfigPath = process.env.TEAM_CONFIG;

	if (!mongoUri || !teamConfigPath) {
		console.error(
			"Usage: TEAM_CONFIG=<yaml> MONGODB_URI=<uri> cli:tail [--all]",
		);
		process.exit(1);
	}

	const teamConfig = loadTeamConfig(teamConfigPath);
	const missionId = teamConfig.mission.id;
	const showAll = process.argv.includes("--all");

	const { client, db } = await connectMongo(mongoUri);
	const col = db.collection("mailbox");

	const pipeline = showAll
		? [
				{
					$match: {
						operationType: "insert",
						"fullDocument.missionId": missionId,
					},
				},
			]
		: [
				{
					$match: {
						operationType: "insert",
						"fullDocument.missionId": missionId,
						"fullDocument.to": "user",
					},
				},
			];

	const stream = col.watch(pipeline, { fullDocument: "updateLookup" });

	console.log(
		`[cli:tail] Mission ${missionId} — ${showAll ? "all messages" : "to:user only"} — Ctrl+C to exit`,
	);

	stream.on("change", (event) => {
		if (event.operationType !== "insert") return;
		// biome-ignore lint/suspicious/noExplicitAny: Change Stream document type
		const msg = (event as any).fullDocument;
		if (!msg) return;
		const ts = new Date(msg.timestamp).toISOString();
		console.log(
			`\n[${ts}] ${msg.from} → ${msg.to.join(", ")} | ${msg.subject}`,
		);
		console.log(msg.body);
	});

	stream.on("error", (err) => {
		console.error("[cli:tail] Error:", err);
		process.exit(1);
	});

	process.on("SIGINT", async () => {
		await stream.close();
		await client.close();
		process.exit(0);
	});
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
