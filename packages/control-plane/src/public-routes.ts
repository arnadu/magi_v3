/**
 * Everything the control plane serves *before* `requireAuth`: the response
 * headers every reply carries, the cockpit's static bundle, the public
 * Firebase client config and the browser's CSP violation sink. Kept apart
 * from `main()` so the unauthenticated surface is one short list to review.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import rateLimit from "express-rate-limit";
import { cspReportHandler, securityHeaders } from "./security-headers.js";

/** Mounts the pre-auth surface and returns the static bundle's directory (for the SPA fallback). */
export function mountPublicSurface(app: express.Express): string {
	// CSP (report-only until CSP_ENFORCE=true), nosniff, referrer and framing
	// policy on every response — static, API and the SPA fallback alike.
	app.use(
		securityHeaders({
			firebaseAuthDomain: process.env.FIREBASE_CLIENT_AUTH_DOMAIN,
		}),
	);

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

	// Browser CSP violation reports: posted by the browser without
	// credentials, so this sits before requireAuth; small body, rate-limited,
	// log-only.
	app.post(
		"/api/csp-report",
		express.json({
			limit: "16kb",
			type: [
				"application/json",
				"application/csp-report",
				"application/reports+json",
			],
		}),
		rateLimit({
			windowMs: 60_000,
			max: 30,
			standardHeaders: true,
			legacyHeaders: false,
		}),
		cspReportHandler,
	);

	return publicDir;
}
