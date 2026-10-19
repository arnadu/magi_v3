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
 *   MongoDB: every collection in PER_MISSION_COLLECTIONS (agent-config/stored),
 *   scoped to missionId, plus this mission's resourceAlertState entries.
 *
 *   Filesystem (unless --db-only):
 *     - $AGENT_WORKDIR/missions/<missionId>/   (shared dir — briefs, scripts, git repo)
 *     - $AGENT_WORKDIR/home/<linuxUser>/missions/<missionId>/  (per-agent private dirs)
 */

import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
	COLLECTION_NAMES,
	loadTeamConfig,
	PER_MISSION_COLLECTIONS,
} from "@magi/agent-config";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({
	path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env"),
	quiet: true,
});

import { resolveLinuxUsers } from "./linux-user.js";
import { injectMissionCopilot } from "./mission-copilot.js";
import { connectMongo } from "./mongo.js";

async function confirm(prompt: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(prompt, (answer) => {
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
	// Mirror daemon.ts's own injection gate (default on, opt out with
	// MISSION_COPILOT_ENABLED=false) — the mission copilot (ADR-0016) is
	// never in the authored YAML, so without this its private workdir
	// (home/copilot/missions/<id>) would be silently left behind on reset.
	if (process.env.MISSION_COPILOT_ENABLED !== "false") {
		injectMissionCopilot(teamConfig);
	}
	const missionId = teamConfig.mission.id;
	const workdir = process.env.AGENT_WORKDIR ?? process.cwd();

	const sharedDir = join(workdir, "missions", missionId);
	const resolvedLinuxUsers = resolveLinuxUsers(teamConfig.agents);
	const agentDirs = teamConfig.agents.map((a) => {
		const linuxUser = resolvedLinuxUsers.get(a.id);
		if (!linuxUser)
			throw new Error(`No Linux user resolved for agent "${a.id}"`);
		return join(workdir, "home", linuxUser, "missions", missionId);
	});

	console.log(`\nMission: ${missionId}`);
	console.log(`\nMongoDB data to delete (missionId = "${missionId}"):`);
	console.log(
		`  ${PER_MISSION_COLLECTIONS.map((k) => COLLECTION_NAMES[k]).join(", ")}, resourceAlertState`,
	);
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
		// Every collection keyed by missionId. Leaving missionStats behind kept
		// a tripped spend cap tripped after a "full" reset.
		const results = await Promise.all(
			PER_MISSION_COLLECTIONS.map((key) =>
				db.collection(COLLECTION_NAMES[key]).deleteMany({ missionId }),
			),
		);
		// resourceAlertState is keyed `<missionId>:<category>` in _id.
		const alerts = await db
			.collection<{ _id: string }>(COLLECTION_NAMES.resourceAlertState)
			.deleteMany({
				_id: {
					$regex: `^${missionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`,
				},
			});
		console.log(`\nDeleted:`);
		PER_MISSION_COLLECTIONS.forEach((key, i) => {
			console.log(
				`  ${COLLECTION_NAMES[key].padEnd(22)} ${results[i].deletedCount} documents`,
			);
		});
		console.log(
			`  ${"resourceAlertState".padEnd(22)} ${alerts.deletedCount} documents`,
		);
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
		if (removed === 0)
			console.log(`\nFilesystem: no directories found (already clean)`);
	}

	console.log("\nReset complete. Start the daemon to begin a fresh mission.");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
