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
import { config as dotenvConfig } from "dotenv";
import express from "express";
import rateLimit from "express-rate-limit";
import { createAuthMiddleware } from "./auth.js";
import { createCopilotRouter } from "./copilot-router.js";
import { PendingActionsStore } from "./copilot-tools.js";
import { initFirebase } from "./firebase.js";
import { createMissionsRouter } from "./missions.js";
import { connectMongo } from "./mongo.js";
import { createProxyRouter } from "./proxy.js";
import { startScheduler } from "./scheduler.js";
import { createTemplatesRouter, seedTemplates } from "./templates.js";

const REPO_ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
);
dotenvConfig({ path: join(REPO_ROOT, ".env"), quiet: true });

async function main(): Promise<void> {
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

	// Seed templates from config/teams/ on startup (idempotent).
	await seedTemplates(db, REPO_ROOT);

	const app = express();

	// Fly.io terminates TLS and sets X-Forwarded-For. Trust one proxy hop so
	// express-rate-limit can correctly identify client IPs.
	app.set("trust proxy", 1);

	// ── Public routes (no auth) ───────────────────────────────────────────────

	// Serve static UI without authentication — the login page is public.
	const publicDir = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"public",
	);
	app.use(
		express.static(publicDir, {
			setHeaders: (res) => {
				res.setHeader("Cache-Control", "no-store");
			},
		}),
	);

	// Firebase client config — served from env vars so dev/prod use different projects.
	// These are public client-side identifiers, not secrets.
	app.get("/firebase-config.js", (_req, res) => {
		res.setHeader("Content-Type", "application/javascript");
		res.setHeader("Cache-Control", "no-store");
		res.send(
			`window.FIREBASE_CONFIG = ${JSON.stringify({
				apiKey: process.env.FIREBASE_CLIENT_API_KEY ?? "",
				authDomain: process.env.FIREBASE_CLIENT_AUTH_DOMAIN ?? "",
				projectId: process.env.FIREBASE_CLIENT_PROJECT_ID ?? "",
			})};`,
		);
	});

	// ── Authenticated routes ──────────────────────────────────────────────────

	const requireAuth = createAuthMiddleware(db);
	app.use(requireAuth);

	// Mission templates — list available team configs.
	// 4 MB limit: template payloads include teamFiles (skills, scripts) which can exceed 100 KB.
	app.use(
		"/api/templates",
		express.json({ limit: "4mb" }),
		createTemplatesRouter(db),
	);

	// Copilot chat API + SSE (per-user daemon started lazily on first message).
	const pendingActions = new PendingActionsStore();
	app.use(
		"/api/copilot",
		express.json({ limit: "4mb" }),
		rateLimit({
			windowMs: 60_000,
			max: 30,
			standardHeaders: true,
			legacyHeaders: false,
		}),
		createCopilotRouter(db, REPO_ROOT, pendingActions),
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

	// Per-user LLM usage summary (admin sees all missions).
	app.get("/api/usage", async (req, res) => {
		const filter = req.isAdmin ? {} : { userId: req.userId };
		const missions = await db
			.collection("missions")
			.find(filter, {
				projection: { missionId: 1, name: 1, userId: 1, _id: 0 },
			})
			.toArray();
		const missionIds = missions.map((m) => m.missionId as string);
		const costs = await db
			.collection("llmCallLog")
			.aggregate([
				{ $match: { missionId: { $in: missionIds } } },
				{
					$group: {
						_id: "$missionId",
						totalCostUsd: { $sum: "$usage.cost.totalCostUsd" },
						calls: { $sum: 1 },
					},
				},
			])
			.toArray();
		const costMap = Object.fromEntries(costs.map((c) => [c._id as string, c]));
		res.json(
			missions.map((m) => ({
				...m,
				usage: costMap[m.missionId as string] ?? { totalCostUsd: 0, calls: 0 },
			})),
		);
	});

	// Reverse proxy to execution plane machines.
	app.use(createProxyRouter(db));

	// Fallback: serve index.html for unknown paths (SPA behaviour).
	// Use regex — bare "*" is rejected by path-to-regexp v8 (Express 4.21+).
	app.get(/.*/, (_req, res) => {
		res.sendFile(join(publicDir, "index.html"));
	});

	const port = Number.parseInt(process.env.PORT ?? "3000", 10);
	const server = app.listen(port, () => {
		console.log(`[control-plane] Listening on port ${port}`);
	});

	// Start scheduled message delivery heartbeat.
	const stopScheduler = startScheduler(db);

	// Graceful shutdown.
	async function shutdown(): Promise<void> {
		console.log("[control-plane] Shutting down…");
		stopScheduler();
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
