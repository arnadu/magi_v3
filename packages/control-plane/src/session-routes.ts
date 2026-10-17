/**
 * The browser session cookie, issued by the server (F-049 / AUTH1 / C2).
 *
 * Before this, the cockpit wrote `magi_session` from JavaScript, so any
 * script running on the page (an XSS in rendered agent output) could read a
 * credential that is, in admin mode, the long-lived CONTROL_API_KEY itself.
 * Now the cockpit presents its credential once as a bearer token to
 * `POST /api/auth/session`, and the cookie that carries it afterwards is
 * `HttpOnly; Secure; SameSite=Strict` — invisible to script, never sent
 * cross-site. `requireAuth` runs before these routes, so the bearer has
 * already been verified by the time the cookie is issued.
 */

import type { Router as ExpressRouter, Request, Response } from "express";
import { Router } from "express";
import { extractBearer } from "./auth.js";

export const SESSION_COOKIE = "magi_session";
/** Matches a Firebase ID token's lifetime; the cockpit re-issues on every token refresh. */
export const SESSION_MAX_AGE_S = 3600;

export function sessionCookieHeader(token: string): string {
	return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_MAX_AGE_S}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookieHeader(): string {
	return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export function createSessionRouter(): ExpressRouter {
	const router = Router();

	// Exchange a verified bearer credential for the HttpOnly cookie.
	router.post("/session", (req: Request, res: Response) => {
		const token = extractBearer(req.headers.authorization);
		if (!token) {
			res.status(400).json({
				error:
					"Send the credential as `Authorization: Bearer …`; the cookie is issued from it",
			});
			return;
		}
		res.setHeader("Set-Cookie", sessionCookieHeader(token));
		res.json({ ok: true, userId: req.userId, isAdmin: Boolean(req.isAdmin) });
	});

	router.get("/me", (req: Request, res: Response) => {
		res.json({ userId: req.userId, isAdmin: Boolean(req.isAdmin) });
	});

	router.post("/logout", (_req: Request, res: Response) => {
		res.setHeader("Set-Cookie", clearSessionCookieHeader());
		res.json({ ok: true });
	});

	return router;
}
