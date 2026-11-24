import { entryTrigger } from "@magi/agent-config";
import { createApp } from "./app.js";
import { ensureSlotIndex } from "./apps-host/slots.js";
/**
 * Control plane entry point.
 *
 * Environment variables:
 *   MONGODB_URI                  required
 *   CONTROL_API_KEY              required — admin fallback auth (CI, bootstrap.sh)
 *   FLY_API_TOKEN_MACHINES       required — Fly Machines API token (magi-missions app)
 *   FLY_MISSIONS_APP_NAME        required — Fly app name for execution plane
 *   FIREBASE_SERVICE_ACCOUNT_KEY required for Firebase auth (JSON string)
 *   FIREBASE_PROJECT_ID          alternative to SERVICE_ACCOUNT_KEY (default credentials)
 *   FIREBASE_CLIENT_API_KEY      served to browser via /firebase-config.js
 *   FIREBASE_CLIENT_AUTH_DOMAIN  served to browser via /firebase-config.js
 *   FIREBASE_CLIENT_PROJECT_ID   served to browser via /firebase-config.js
 *   PORT                         optional — HTTP listen port (default: 3000)
 */

import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exitOnFatal } from "@magi/agent-runtime-worker";
import { config as dotenvConfig } from "dotenv";
import type { Db, MongoClient } from "mongodb";
import {
	type CopilotRuntime,
	createCopilotRuntime,
} from "./copilot-runtime.js";
import { startCopilotWaker } from "./copilot-waker.js";
import { initFirebase } from "./firebase.js";
import { ensureMissionIdIndex } from "./mission-claims.js";
import { connectMongo } from "./mongo.js";
import { MongoPendingActionsStore } from "./pending-actions.js";
import { installProcessGuards } from "./process-guards.js";
import { startResourceMonitor } from "./resource-monitor.js";
import { startScheduler } from "./scheduler.js";
import {
	backfillMissionCaps,
	backfillMissionCeilings,
	platformAdminUserIds,
} from "./spend-policy.js";
import { loadTemplates } from "./templates.js";

const REPO_ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
);
dotenvConfig({ path: join(REPO_ROOT, ".env"), quiet: true });

/** PLATFORM_ADMIN_USER_IDS (comma-separated UIDs), ATLAS_STORAGE_LIMIT_MB, RESOURCE_REPORT_HOUR_UTC — see CLAUDE.md. */
function resourceMonitorOptionsFromEnv(env: NodeJS.ProcessEnv): {
	platformAdminUserIds: string[];
	atlasStorageLimitMb?: number;
	reportHourUtc?: number;
} {
	return {
		platformAdminUserIds: [...platformAdminUserIds(env)],
		atlasStorageLimitMb: env.ATLAS_STORAGE_LIMIT_MB
			? Number.parseInt(env.ATLAS_STORAGE_LIMIT_MB, 10)
			: undefined,
		reportHourUtc: env.RESOURCE_REPORT_HOUR_UTC
			? Number.parseInt(env.RESOURCE_REPORT_HOUR_UTC, 10)
			: undefined,
	};
}

const REQUIRED_ENV = [
	"MONGODB_URI",
	"CONTROL_API_KEY",
	"FLY_API_TOKEN_MACHINES",
	"FLY_MISSIONS_APP_NAME",
] as const;

/** Exits when a required env var is missing; returns the Mongo URI. */
function requireEnv(): string {
	const missing = REQUIRED_ENV.find((name) => !process.env[name]);
	const mongoUri = process.env.MONGODB_URI;
	if (missing !== undefined || !mongoUri) {
		console.error(`Error: ${missing ?? "MONGODB_URI"} is required`);
		process.exit(1);
	}
	return mongoUri;
}

/**
 * The scheduler, the copilot waker and the resource monitor, plus graceful
 * shutdown on SIGTERM/SIGINT.
 */
function startBackgroundServices(
	db: Db,
	client: MongoClient,
	copilotRuntime: CopilotRuntime,
	server: Server,
): void {
	// Start scheduled message delivery heartbeat.
	const stopScheduler = startScheduler(db, {
		platformAdminUserIds: resourceMonitorOptionsFromEnv(process.env)
			.platformAdminUserIds,
	});
	// Start a user's copilot daemon whenever mail arrives for it (ADR-0032).
	const stopCopilotWaker = startCopilotWaker(db, (userId) =>
		copilotRuntime.ensureCopilotRunning(userId),
	);
	// Proactive resource oversight: Atlas storage, OOM detection, spend/upgrade
	// alerts, and the daily report (ADR-0032). An empty PLATFORM_ADMIN_USER_IDS
	// is valid (logged by atlas-usage.ts on every tick) — it just means no one
	// receives the Atlas-storage alert or the report's Atlas section.
	const stopResourceMonitor = startResourceMonitor(
		db,
		client,
		resourceMonitorOptionsFromEnv(process.env),
	);
	// Idle copilot daemons are stopped so memory does not grow with every
	// user who ever wrote to the copilot (CW3).
	const idleSweep = setInterval(
		entryTrigger("housekeeping", () => {
			const evicted = copilotRuntime.evictIdle();
			if (evicted.length > 0) {
				console.log(
					`[control-plane] stopped ${evicted.length} idle copilot daemon(s)`,
				);
			}
		}),
		5 * 60_000,
	);
	idleSweep.unref();

	// Graceful shutdown.
	async function shutdown(): Promise<void> {
		console.log("[control-plane] Shutting down…");
		stopScheduler();
		stopCopilotWaker();
		stopResourceMonitor();
		clearInterval(idleSweep);
		server.close(() => {
			client
				.close()
				.then(() => process.exit(0))
				.catch(() => process.exit(1));
		});
	}

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

async function main(): Promise<void> {
	installProcessGuards();
	const mongoUri = requireEnv();

	// Initialise Firebase Admin SDK (required for JWT verification).
	// Skipped gracefully in environments that only use CONTROL_API_KEY (e.g. local unit tests).
	try {
		initFirebase();
	} catch (e) {
		console.warn(
			`[control-plane] Firebase init skipped: ${(e as Error).message}`,
		);
	}

	const { client, db } = await connectMongo(mongoUri);

	// Templates are immutable disk files, loaded once into memory at startup
	// (ADR-0021) — no database involved.
	loadTemplates(REPO_ROOT);

	// Shared by the control-plane copilot and the mission-copilot proxy.
	const pendingActions = new MongoPendingActionsStore(db);
	await pendingActions.ensureIndexes();
	await ensureMissionIdIndex(db);
	await ensureSlotIndex(db);
	await backfillMissionCaps(db);
	await backfillMissionCeilings(db);
	const copilotRuntime = createCopilotRuntime(db, REPO_ROOT, pendingActions);

	const app = createApp({
		db,
		pendingActions,
		copilotRuntime,
		repoRoot: REPO_ROOT,
	});

	const port = Number.parseInt(process.env.PORT ?? "3000", 10);
	const server = app.listen(port, () => {
		console.log(`[control-plane] Listening on port ${port}`);
	});
	startBackgroundServices(db, client, copilotRuntime, server);
}

main().catch(exitOnFatal("control-plane"));
