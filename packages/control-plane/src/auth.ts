import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Db } from "mongodb";
import { FailedAuthLimiter } from "./auth-limiter.js";
import { verifyFirebaseToken } from "./firebase.js";
import { syncFirebaseUser } from "./users.js";

/**
 * Dual-mode authentication middleware.
 *
 * Accepts credentials via:
 *   Authorization: Bearer <token>   (preferred; also what POST /api/auth/session takes)
 *   X-Api-Key: <key>
 *   Cookie: magi_session=<token>     (HttpOnly, issued by POST /api/auth/session —
 *                                     carries browser requests, EventSource included)
 * A `?token=` query credential is deliberately not accepted: it lands in
 * proxy logs, browser history and referrers (C2), and nothing needs it —
 * EventSource sends the cookie with `withCredentials`.
 *
 * Two credential types are accepted:
 *   CONTROL_API_KEY  → req.userId = "admin", req.isAdmin = true  (sees all missions)
 *   Firebase JWT     → req.userId = Firebase UID, req.isAdmin = false
 */
export function createAuthMiddleware(
	db: Db,
	limiter: FailedAuthLimiter = new FailedAuthLimiter(),
) {
	return async function requireAuth(
		req: Request,
		res: Response,
		next: NextFunction,
	): Promise<void> {
		const provided =
			extractBearer(req.headers.authorization) ??
			(req.headers["x-api-key"] as string | undefined) ??
			extractCookie(req.headers.cookie, "magi_session");

		// AUTH-BF: a client that keeps failing is answered 429 for the rest of
		// its window; successes do not reset it (a guesser interleaving a valid
		// Firebase token with admin-key guesses gains nothing).
		const client = req.ip ?? "unknown";
		if (limiter.isBlocked(client)) {
			res.setHeader("Retry-After", String(limiter.retryAfterSeconds(client)));
			res
				.status(429)
				.json({ error: "Too many failed authentication attempts" });
			return;
		}

		// 1. CONTROL_API_KEY → admin (CI, headless scripts, bootstrap.sh)
		const apiKey = process.env.CONTROL_API_KEY;
		if (apiKey && provided && safeEqual(provided, apiKey)) {
			req.userId = "admin";
			req.isAdmin = true;
			next();
			return;
		}

		// 2. Firebase JWT → regular user
		if (provided) {
			try {
				const { uid, email, displayName } = await verifyFirebaseToken(provided);
				await syncFirebaseUser(db, uid, email, displayName);
				req.userId = uid;
				req.isAdmin = false;
				next();
				return;
			} catch (e) {
				console.error(
					`[auth] Firebase token verification failed: ${(e as Error).message}`,
				);
			}
		} else {
			console.warn(`[auth] 401 — no credential on ${req.method} ${req.path}`);
		}

		if (provided) limiter.fail(client);
		res.status(401).json({ error: "Unauthorized" });
	};
}

export function safeEqual(a: string, b: string): boolean {
	// Constant-time comparison. HMAC both inputs to fixed-length 32-byte digests
	// so timingSafeEqual never leaks length via an early return on differing
	// lengths. The "cmp" key is NOT a secret — it is a fixed public salt used only
	// to normalise lengths; the security comes from timingSafeEqual over equal-
	// length buffers, not from the key. (semgrep flags any hardcoded HMAC key.)
	// nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
	const ha = createHmac("sha256", "cmp").update(a).digest();
	// nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
	const hb = createHmac("sha256", "cmp").update(b).digest();
	return timingSafeEqual(ha, hb);
}

export function extractBearer(header: string | undefined): string | undefined {
	if (!header?.startsWith("Bearer ")) return undefined;
	return header.slice(7);
}

export function extractCookie(
	cookieHeader: string | undefined,
	name: string,
): string | undefined {
	if (!cookieHeader) return undefined;
	for (const part of cookieHeader.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() === name)
			return decodeURIComponent(part.slice(eq + 1));
	}
	return undefined;
}
