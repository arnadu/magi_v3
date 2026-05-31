import type { NextFunction, Request, Response } from "express";
import type { Db } from "mongodb";
import { verifyFirebaseToken } from "./firebase.js";
import { syncFirebaseUser } from "./users.js";

/**
 * Dual-mode authentication middleware.
 *
 * Accepts credentials via:
 *   Authorization: Bearer <token>   (preferred)
 *   X-Api-Key: <key>
 *   Cookie: magi_session=<key>       (set by legacy login form)
 *   ?token=<token>                   (query param — required for EventSource SSE)
 *
 * Two credential types are accepted:
 *   CONTROL_API_KEY  → req.userId = "admin", req.isAdmin = true  (sees all missions)
 *   Firebase JWT     → req.userId = Firebase UID, req.isAdmin = false
 */
export function createAuthMiddleware(db: Db) {
	return async function requireAuth(
		req: Request,
		res: Response,
		next: NextFunction,
	): Promise<void> {
		const provided =
			extractBearer(req.headers.authorization) ??
			(req.headers["x-api-key"] as string | undefined) ??
			extractCookie(req.headers.cookie, "magi_session") ??
			(req.query.token as string | undefined);

		// 1. CONTROL_API_KEY → admin (CI, headless scripts, bootstrap.sh)
		const apiKey = process.env.CONTROL_API_KEY;
		if (apiKey && provided === apiKey) {
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
			} catch {
				// Invalid or expired token — fall through to 401
			}
		}

		res.status(401).json({ error: "Unauthorized" });
	};
}

function extractBearer(header: string | undefined): string | undefined {
	if (!header?.startsWith("Bearer ")) return undefined;
	return header.slice(7);
}

function extractCookie(
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
