#!/usr/bin/env node

/**
 * Inject a message into a running daemon via MongoDB.
 *
 * Usage:
 *   TEAM_CONFIG=<yaml> MONGODB_URI=<uri> node dist/cli-post.js [--to <agentId>] <message>
 *
 * --to <agentId>   Target agent (default: team lead)
 *
 * Environment variables:
 *   MONGODB_URI    required
 *   TEAM_CONFIG    required — used to resolve missionId and default recipient
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTeamConfig } from "@magi/agent-config";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({
	path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env"),
	quiet: true,
});

import { createMongoMailboxRepository } from "./mailbox.js";
import { connectMongo } from "./mongo.js";

async function main(): Promise<void> {
	const mongoUri = process.env.MONGODB_URI;
	const teamConfigPath = process.env.TEAM_CONFIG;

	if (!mongoUri || !teamConfigPath) {
		console.error(
			"Usage: TEAM_CONFIG=<yaml> MONGODB_URI=<uri> cli:post [--to <agentId>] <message>",
		);
		process.exit(1);
	}

	const teamConfig = loadTeamConfig(teamConfigPath);
	const missionId = teamConfig.mission.id;

	// Parse --to flag and remaining args as message body.
	const rawArgs = process.argv.slice(2);
	const toIdx = rawArgs.indexOf("--to");
	let to: string;
	let bodyParts: string[];

	if (toIdx !== -1 && rawArgs[toIdx + 1]) {
		to = rawArgs[toIdx + 1];
		bodyParts = rawArgs.filter((_, i) => i !== toIdx && i !== toIdx + 1);
	} else {
		const leadAgent = teamConfig.agents[0];
		if (!leadAgent) throw new Error("Team config has no agents");
		to = leadAgent.id;
		bodyParts = rawArgs;
	}

	const body = bodyParts.join(" ").trim();
	if (!body) {
		console.error("Error: message body is required");
		process.exit(1);
	}

	const { client, db } = await connectMongo(mongoUri);
	const mailboxRepo = createMongoMailboxRepository(db, missionId);

	const msg = await mailboxRepo.post({
		missionId,
		from: "user",
		to: [to],
		subject: "User message",
		body,
	});

	console.log(`Message posted (id: ${msg.id}) → ${to}`);
	await client.close();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
