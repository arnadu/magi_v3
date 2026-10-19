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

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { storedCollection } from "@magi/agent-config";
import {
	CLAUDE_HAIKU,
	CLAUDE_SONNET,
	fetchOpenRouterCatalog,
	type OpenRouterModelInfo,
} from "@magi/agent-runtime-worker";
import { config as dotenvConfig } from "dotenv";
import express from "express";
import rateLimit from "express-rate-limit";
import { asyncRoutes } from "./async-handler.js";
import { createAuthMiddleware } from "./auth.js";
import { createCatalogRouter } from "./catalog-routes.js";
import { createCopilotRouter } from "./copilot-router.js";
import { createCopilotRuntime } from "./copilot-runtime.js";
import { startCopilotWaker } from "./copilot-waker.js";
import { initFirebase } from "./firebase.js";
import { ensureMissionIdIndex } from "./mission-claims.js";
import { createMissionCopilotRouter } from "./mission-copilot-router.js";
import { createMissionResourceRoutes } from "./mission-resource-routes.js";
import { createMissionsRouter } from "./missions.js";
import { connectMongo } from "./mongo.js";
import { MongoPendingActionsStore } from "./pending-actions.js";
import { errorMiddleware, installProcessGuards } from "./process-guards.js";
import { createProxyRouter } from "./proxy.js";
import { mountPublicSurface } from "./public-routes.js";
import { startResourceMonitor } from "./resource-monitor.js";
import { startScheduler } from "./scheduler.js";
import { createSessionRouter } from "./session-routes.js";
import {
	backfillMissionCeilings,
	platformAdminUserIds,
} from "./spend-policy.js";
import { createTemplatesRouter, loadTemplates } from "./templates.js";
import { lifetimeCostByMission } from "./usage-queries.js";

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

async function main(): Promise<void> {
	installProcessGuards();
	const mongoUri = process.env.MONGODB_URI;
	if (!mongoUri) {
		console.error("Error: MONGODB_URI is required");
		process.exit(1);
	}
	if (!process.env.CONTROL_API_KEY) {
		console.error("Error: CONTROL_API_KEY is required");
		process.exit(1);
	}
	if (!process.env.FLY_API_TOKEN_MACHINES) {
		console.error("Error: FLY_API_TOKEN_MACHINES is required");
		process.exit(1);
	}
	if (!process.env.FLY_MISSIONS_APP_NAME) {
		console.error("Error: FLY_MISSIONS_APP_NAME is required");
		process.exit(1);
	}

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
	const appRoutes = asyncRoutes(app);

	// Fly.io terminates TLS and sets X-Forwarded-For. Trust one proxy hop so
	// express-rate-limit can correctly identify client IPs.
	app.set("trust proxy", 1);

	// ── Public routes (no auth) ───────────────────────────────────────────────

	// Serve static UI without authentication — the login page is public.
	const publicDir = mountPublicSurface(app);

	// Mission-copilot GitHub proxy (ADR-0016) — machine-to-machine auth via
	// per-mission MONITOR_TOKEN, not Firebase/CONTROL_API_KEY, so it must be
	// mounted before requireAuth below. Rate-limited per-IP: each mission runs
	// on its own stable WireGuard address, so this naturally isolates the
	// limit per mission — one mission's copilot going haywire can't exhaust
	// the quota for every other mission. That's a property of the *default*
	// per-IP keying; re-check this comment if the keying is ever changed.
	// Shared by the control-plane copilot and the mission-copilot proxy: a
	// mission copilot's GitHub-issue request becomes a pending action in the
	// mission owner's cockpit (github-issues.ts).
	const pendingActions = new MongoPendingActionsStore(db);
	await pendingActions.ensureIndexes();
	await ensureMissionIdIndex(db);
	await backfillMissionCeilings(db);
	const copilotRuntime = createCopilotRuntime(db, REPO_ROOT, pendingActions);

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

	// ── Authenticated routes ──────────────────────────────────────────────────

	const requireAuth = createAuthMiddleware(db);
	app.use(requireAuth);

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

	// Per-user LLM usage summary (admin sees all missions).
	appRoutes.get("/api/usage", async (req, res) => {
		const filter = req.isAdmin ? {} : { userId: req.userId };
		const missions = await storedCollection(db, "missions")
			.find(filter, {
				projection: { missionId: 1, name: 1, userId: 1, _id: 0 },
			})
			.toArray();
		const missionIds = missions.map((m) => m.missionId as string);
		const costs = await lifetimeCostByMission(db, missionIds);
		res.json(
			missions.map((m) => ({
				...m,
				usage: costs.get(m.missionId as string) ?? {
					totalCostUsd: 0,
					calls: 0,
				},
			})),
		);
	});

	// Model catalog for the model picker (mission/agent config editor + copilot
	// settings) — first-party Anthropic (hardcoded: no public unauthenticated
	// discovery endpoint) + OpenRouter's live catalog (cached process-wide by
	// fetchOpenRouterCatalog itself, so this route is cheap after the first call).
	const ANTHROPIC_MODELS: OpenRouterModelInfo[] = [
		{
			id: "claude-opus-4-8",
			name: "Claude Opus 4.8",
			contextLength: 1_000_000,
			supportsVision: true,
			pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		},
		{
			id: CLAUDE_SONNET.id,
			name: "Claude Sonnet 4.6",
			contextLength: CLAUDE_SONNET.contextWindow,
			supportsVision: true,
			pricing: {
				input: CLAUDE_SONNET.cost.input,
				output: CLAUDE_SONNET.cost.output,
				cacheRead: CLAUDE_SONNET.cost.cacheRead,
				cacheWrite: CLAUDE_SONNET.cost.cacheWrite,
			},
		},
		{
			id: CLAUDE_HAIKU.id,
			name: "Claude Haiku 4.5",
			contextLength: CLAUDE_HAIKU.contextWindow,
			supportsVision: true,
			pricing: {
				input: CLAUDE_HAIKU.cost.input,
				output: CLAUDE_HAIKU.cost.output,
				cacheRead: CLAUDE_HAIKU.cost.cacheRead,
				cacheWrite: CLAUDE_HAIKU.cost.cacheWrite,
			},
		},
	];
	appRoutes.get("/api/models", async (_req, res) => {
		const openrouter = await fetchOpenRouterCatalog();
		res.json({ anthropic: ANTHROPIC_MODELS, openrouter });
	});

	// Reverse proxy to execution plane machines.
	app.use(createProxyRouter(db));

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

	// Graceful shutdown.
	async function shutdown(): Promise<void> {
		console.log("[control-plane] Shutting down…");
		stopScheduler();
		stopCopilotWaker();
		stopResourceMonitor();
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

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
