#!/usr/bin/env node

/**
 * Send SIGTERM to a running MAGI daemon using its PID file.
 *
 * Usage:
 *   MISSION_ID=equity-research npm run cli:stop
 *   MISSION_ID=equity-research AGENT_WORKDIR=/path/to/workdir npm run cli:stop
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({
	path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env"),
	quiet: true,
});

const missionId = process.env.MISSION_ID;
const workdir = process.env.AGENT_WORKDIR ?? process.cwd();

if (!missionId) {
	console.error("Error: MISSION_ID is required");
	console.error("Usage: MISSION_ID=<id> npm run cli:stop");
	process.exit(1);
}

const pidFile = join(workdir, "missions", missionId, "daemon.pid");

try {
	const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
	if (Number.isNaN(pid)) throw new Error("PID file contains invalid value");
	process.kill(pid, "SIGTERM");
	console.log(
		`[cli:stop] Sent SIGTERM to daemon PID ${pid} (mission: ${missionId})`,
	);
	console.log(
		`[cli:stop] Watch shutdown: MISSION_ID=${missionId} npm run cli:tail`,
	);
} catch (e) {
	console.error(`[cli:stop] Could not stop daemon: ${(e as Error).message}`);
	console.error(`[cli:stop] PID file expected at: ${pidFile}`);
	process.exit(1);
}
