#!/usr/bin/env node

/**
 * Reset all MongoDB data for a mission and wipe its workspace directory.
 *
 * Usage:
 *   TEAM_CONFIG=<yaml> MONGODB_URI=<uri> npm run cli:reset
 *   TEAM_CONFIG=<yaml> MONGODB_URI=<uri> npm run cli:reset -- --db-only   # skip filesystem wipe
 *   TEAM_CONFIG=<yaml> MONGODB_URI=<uri> npm run cli:reset -- --yes        # skip confirmation
 *
 * What is deleted:
 *   MongoDB collections (scoped to missionId):
 *     - mailbox
 *     - conversationMessages
 *     - llmCallLog
 *     - scheduled_messages  (all docs for this mission)
 *
 *   Filesystem (unless --db-only):
 *     - $AGENT_WORKDIR/missions/<missionId>/   (shared dir — briefs, scripts, git repo)
 *     - $AGENT_WORKDIR/home/<linuxUser>/missions/<missionId>/  (per-agent private dirs)
 */

import { createInterface } from "node:readline";
import { rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTeamConfig } from "@magi/agent-config";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({
	path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env"),
	quiet: true,
});

import { connectMongo } from "./mongo.js";

async function confirm(prompt: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise(resolve => {
		rl.question(prompt, answer => {
			rl.close();
			resolve(answer.trim().toLowerCase() === "y");
		});
	});
}

async function main(): Promise<void> {
	const mongoUri = process.env.MONGODB_URI;
	const teamConfigPath = process.env.TEAM_CONFIG;

	if (!mongoUri || !teamConfigPath) {
		console.error(
			"Usage: TEAM_CONFIG=<yaml> MONGODB_URI=<uri> npm run cli:reset [-- --db-only] [-- --yes]",
		);
		process.exit(1);
	}

	const args = process.argv.slice(2);
	const dbOnly = args.includes("--db-only");
	const skipConfirm = args.includes("--yes");

	const teamConfig = loadTeamConfig(teamConfigPath);
	const missionId = teamConfig.mission.id;
	const workdir = process.env.AGENT_WORKDIR ?? process.cwd();

	const sharedDir = join(workdir, "missions", missionId);
	const agentDirs = teamConfig.agents.map(a =>
		join(workdir, "home", a.linuxUser, "missions", missionId),
	);

	console.log(`\nMission: ${missionId}`);
	console.log(`\nMongoDB data to delete (missionId = "${missionId}"):`);
	console.log(`  mailbox, conversationMessages, llmCallLog, scheduled_messages`);
	if (!dbOnly) {
		console.log(`\nFilesystem paths to delete:`);
		console.log(`  ${sharedDir}`);
		for (const d of agentDirs) console.log(`  ${d}`);
	}

	if (!skipConfirm) {
		const ok = await confirm("\nProceed? [y/N] ");
		if (!ok) {
			console.log("Aborted.");
			process.exit(0);
		}
	}

	const { client, db } = await connectMongo(mongoUri);
	try {
		const results = await Promise.all([
			db.collection("mailbox").deleteMany({ missionId }),
			db.collection("conversationMessages").deleteMany({ missionId }),
			db.collection("llmCallLog").deleteMany({ missionId }),
			db.collection("scheduled_messages").deleteMany({ missionId }),
		]);
		const [mailbox, conv, llm, sched] = results;
		console.log(`\nDeleted:`);
		console.log(`  mailbox:              ${mailbox.deletedCount} documents`);
		console.log(`  conversationMessages: ${conv.deletedCount} documents`);
		console.log(`  llmCallLog:           ${llm.deletedCount} documents`);
		console.log(`  scheduled_messages:   ${sched.deletedCount} documents`);
	} finally {
		await client.close();
	}

	if (!dbOnly) {
		let removed = 0;
		for (const dir of [sharedDir, ...agentDirs]) {
			if (existsSync(dir)) {
				rmSync(dir, { recursive: true, force: true });
				console.log(`  removed: ${dir}`);
				removed++;
			}
		}
		if (removed === 0) console.log(`\nFilesystem: no directories found (already clean)`);
	}

	console.log("\nReset complete. Start the daemon to begin a fresh mission.");
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
