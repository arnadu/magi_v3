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
import express from "express";
import rateLimit from "express-rate-limit";
import type { Db, MongoClient } from "mongodb";
import { createAuthMiddleware } from "./auth.js";
import { createCatalogRouter } from "./catalog-routes.js";
import { createCopilotRouter } from "./copilot-router.js";
import {
	type CopilotRuntime,
	createCopilotRuntime,
} from "./copilot-runtime.js";
import { startCopilotWaker } from "./copilot-waker.js";
import { initFirebase } from "./firebase.js";
import { ensureMissionIdIndex } from "./mission-claims.js";
import { createMissionCopilotRouter } from "./mission-copilot-router.js";
import { createMissionResourceRoutes } from "./mission-resource-routes.js";
import { createMissionsRouter } from "./missions.js";
import { connectMongo } from "./mongo.js";
import { MongoPendingActionsStore } from "./pending-actions.js";
import { createPlatformRoutes } from "./platform-routes.js";
import { errorMiddleware, installProcessGuards } from "./process-guards.js";
import { createProxyRouter } from "./proxy.js";
import { mountPublicSurface } from "./public-routes.js";
import { startResourceMonitor } from "./resource-monitor.js";
import { startScheduler } from "./scheduler.js";
import { createSessionRouter } from "./session-routes.js";
import {
	backfillMissionCaps,
	backfillMissionCeilings,
	platformAdminUserIds,
} from "./spend-policy.js";
import { createTemplatesRouter, loadTemplates } from "./templates.js";

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
 * Mission-copilot GitHub proxy (ADR-0016) — machine-to-machine auth via
 * per-mission MONITOR_TOKEN, not Firebase/CONTROL_API_KEY, so it must be
 * mounted before requireAuth. Rate-limited per-IP: each mission runs on its
 * own stable WireGuard address, so this naturally isolates the limit per
 * mission — one mission's copilot going haywire can't exhaust the quota for
 * every other mission. That's a property of the *default* per-IP keying;
 * re-check this comment if the keying is ever changed. A mission copilot's
 * GitHub-issue request becomes a pending action in the mission owner's
 * cockpit (github-issues.ts).
 */
function mountMissionCopilotProxy(
	app: express.Express,
	db: Db,
	pendingActions: MongoPendingActionsStore,
	copilotRuntime: CopilotRuntime,
): void {
	app.use(
		"/api/mission-copilot",
		express.json({ limit: "1mb" }),
		rateLimit({
			windowMs: 60_000,
			max: 20,
			standardHeaders: true,
			legacyHeaders: false,
		}),
		createMissionCopilotRouter(db, {
			pending: pendingActions,
			notify: (userId, type, data) =>
				copilotRuntime.eventBus.push(userId, type, data),
		}),
	);
}

/** Everything behind requireAuth, in mount order. */
function mountAuthenticatedApi(
	app: express.Express,
	db: Db,
	pendingActions: MongoPendingActionsStore,
	copilotRuntime: CopilotRuntime,
): void {
	app.use(createAuthMiddleware(db));

	// API responses must never be cached. Express sets an ETag but no
	// Cache-Control, so browsers apply heuristic caching and a normal reload can
	// serve a stale template/config/mission (the operator should not need a
	// force-reload to see a just-saved edit).
	app.use("/api", (_req, res, next) => {
		res.setHeader("Cache-Control", "no-store");
		next();
	});

	// Session cookie issue/inspect/clear — the bearer presented to /session has
	// already passed requireAuth above.
	app.use("/api/auth", createSessionRouter());

	// Skill and tool names the cockpit's config editors may toggle.
	app.use("/api/catalog", createCatalogRouter(REPO_ROOT));

	// Mission templates — list available team configs.
	// 4 MB limit: template payloads include teamFiles (skills, scripts) which can exceed 100 KB.
	app.use(
		"/api/templates",
		express.json({ limit: "4mb" }),
		createTemplatesRouter(),
	);

	// Copilot chat API + SSE (per-user daemon started lazily on first message).
	app.use(
		"/api/copilot",
		express.json({ limit: "4mb" }),
		rateLimit({
			windowMs: 60_000,
			max: 30,
			standardHeaders: true,
			legacyHeaders: false,
		}),
		createCopilotRouter(db, pendingActions, copilotRuntime),
	);

	// Mission CRUD + lifecycle.
	// 4 MB limit: mission creation and config-edit endpoints accept teamFiles (skills, scripts).
	// express.json() is scoped here — proxy routes below must NOT consume the
	// request body or http-proxy-middleware cannot forward it to the daemon.
	app.use(
		"/api/missions",
		express.json({ limit: "4mb" }),
		createMissionsRouter(db),
	);
	app.use("/api/missions", createMissionResourceRoutes(db));

	// Per-user LLM usage summary and the model-picker catalog.
	app.use(createPlatformRoutes(db));

	// Reverse proxy to execution plane machines.
	app.use(createProxyRouter(db));
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
	const stopScheduler = startScheduler(db);
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
	const idleSweep = setInterval(() => {
		const evicted = copilotRuntime.evictIdle();
		if (evicted.length > 0) {
			console.log(
				`[control-plane] stopped ${evicted.length} idle copilot daemon(s)`,
			);
		}
	}, 5 * 60_000);
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

	const app = express();

	// Fly.io terminates TLS and sets X-Forwarded-For. Trust one proxy hop so
	// express-rate-limit can correctly identify client IPs.
	app.set("trust proxy", 1);

	// Serve static UI without authentication — the login page is public.
	const publicDir = mountPublicSurface(app);

	// Shared by the control-plane copilot and the mission-copilot proxy.
	const pendingActions = new MongoPendingActionsStore(db);
	await pendingActions.ensureIndexes();
	await ensureMissionIdIndex(db);
	await backfillMissionCaps(db);
	await backfillMissionCeilings(db);
	const copilotRuntime = createCopilotRuntime(db, REPO_ROOT, pendingActions);

	mountMissionCopilotProxy(app, db, pendingActions, copilotRuntime);
	mountAuthenticatedApi(app, db, pendingActions, copilotRuntime);

	// Fallback: serve index.html for unknown paths (SPA behaviour).
	// Use regex — bare "*" is rejected by path-to-regexp v8 (Express 4.21+).
	app.get(/.*/, (_req, res) => {
		res.sendFile(join(publicDir, "index.html"));
	});

	// Terminal error handler — after every route, so a `next(err)` from
	// asyncHandler (or a synchronous throw) becomes a JSON 500 instead of a
	// hung request.
	app.use(errorMiddleware());

	const port = Number.parseInt(process.env.PORT ?? "3000", 10);
	const server = app.listen(port, () => {
		console.log(`[control-plane] Listening on port ${port}`);
	});
	startBackgroundServices(db, client, copilotRuntime, server);
}

main().catch(exitOnFatal("control-plane"));
