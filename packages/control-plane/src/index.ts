/**
 * Control plane entry point.
 *
 * Environment variables:
 *   MONGODB_URI             required
 *   CONTROL_API_KEY         required — operator authenticates with this key
 *   FLY_API_TOKEN_MACHINES  required — Fly Machines API token (magi-missions app)
 *   FLY_MISSIONS_APP_NAME   required — Fly app name for execution plane
 *   PORT                    optional — HTTP listen port (default: 3000)
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";
import express from "express";
import { requireApiKey } from "./auth.js";
import { createMissionsRouter } from "./missions.js";
import { connectMongo } from "./mongo.js";
import { createProxyRouter } from "./proxy.js";
import { startScheduler } from "./scheduler.js";
import { createTemplatesRouter } from "./templates.js";

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

	const { client, db } = await connectMongo(mongoUri);

	const app = express();

	// Serve static UI without authentication — the login page itself is public.
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

	// All API and proxy routes require authentication.
	app.use(requireApiKey);

	// Mission templates — list available team configs.
	app.use("/api/templates", express.json(), createTemplatesRouter(db));

	// Mission CRUD + lifecycle.
	// express.json() is scoped here — proxy routes below must NOT consume the
	// request body or http-proxy-middleware cannot forward it to the daemon.
	app.use("/api/missions", express.json(), createMissionsRouter(db));

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
