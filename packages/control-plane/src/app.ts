/**
 * The control plane's Express app: the public surface, the mission-copilot proxy, and
 * everything behind requireAuth, in mount order. Built here so that a test can build the
 * same app (the API surface, the attack tests) without a database or a listening port.
 */
import express from "express";
import rateLimit from "express-rate-limit";
import type { Db } from "mongodb";
import { mount } from "./api-surface.js";
import { createAppOpenRoutes } from "./app-open-routes.js";
import { createAuthMiddleware } from "./auth.js";
import { createCatalogRouter } from "./catalog-routes.js";
import { createCopilotRouter } from "./copilot-router.js";
import type { CopilotRuntime } from "./copilot-runtime.js";
import { createMissionCopilotRouter } from "./mission-copilot-router.js";
import { createMissionResourceRoutes } from "./mission-resource-routes.js";
import { createMissionsRouter } from "./missions.js";
import type { MongoPendingActionsStore } from "./pending-actions.js";
import { createPlatformRoutes } from "./platform-routes.js";
import { errorMiddleware } from "./process-guards.js";
import { createProxyRouter } from "./proxy.js";
import { mountPublicSurface } from "./public-routes.js";
import { createSessionRouter } from "./session-routes.js";
import { createTemplatesRouter } from "./templates.js";

export interface AppDeps {
	db: Db;
	pendingActions: MongoPendingActionsStore;
	copilotRuntime: CopilotRuntime;
	repoRoot: string;
}

export function createApp(deps: AppDeps): express.Express {
	const { db, pendingActions, copilotRuntime, repoRoot } = deps;
	const app = express();

	// Fly.io terminates TLS and sets X-Forwarded-For. Trust one proxy hop so
	// express-rate-limit can correctly identify client IPs.
	app.set("trust proxy", 1);

	// Serve static UI without authentication — the login page is public.
	const publicDir = mountPublicSurface(app);

	mountMissionCopilotProxy(app, db, pendingActions, copilotRuntime);
	mountAuthenticatedApi(app, db, pendingActions, copilotRuntime, repoRoot);

	// Fallback: serve index.html for unknown paths (SPA behaviour).
	// Use regex — bare "*" is rejected by path-to-regexp v8 (Express 4.21+).
	app.get(/.*/, (_req, res) => {
		res.sendFile(`${publicDir}/index.html`);
	});

	// Terminal error handler — after every route, so a `next(err)` from
	// asyncHandler (or a synchronous throw) becomes a JSON 500 instead of a
	// hung request.
	app.use(errorMiddleware());
	return app;
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
	mount(
		app,
		"/api/mission-copilot",
		"monitor-token",
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
	repoRoot: string,
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
	mount(app, "/api/auth", "operator", createSessionRouter());

	// Skill and tool names the cockpit's config editors may toggle.
	mount(app, "/api/catalog", "operator", createCatalogRouter(repoRoot));

	// Mission templates — list available team configs.
	// 4 MB limit: template payloads include teamFiles (skills, scripts) which can exceed 100 KB.
	mount(
		app,
		"/api/templates",
		"operator",
		express.json({ limit: "4mb" }),
		createTemplatesRouter(),
	);

	// Copilot chat API + SSE (per-user daemon started lazily on first message).
	mount(
		app,
		"/api/copilot",
		"operator",
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
	mount(
		app,
		"/api/missions",
		"operator",
		express.json({ limit: "4mb" }),
		createMissionsRouter(db),
	);
	mount(app, "/api/missions", "operator", createMissionResourceRoutes(db));
	// Interactive apps (ADR-0037): the Open button and the apps host's "open it again".
	const appOpen = createAppOpenRoutes(db);
	mount(app, "/api/missions", "operator", appOpen.missionsRouter);
	mount(app, "/api/apps", "operator", appOpen.appsRouter);

	// Per-user LLM usage summary and the model-picker catalog.
	mount(app, "/", "operator", createPlatformRoutes(db));

	// Reverse proxy to execution plane machines.
	mount(app, "/", "operator", createProxyRouter(db));
}
