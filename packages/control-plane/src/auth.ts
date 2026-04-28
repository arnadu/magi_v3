import type { NextFunction, Request, Response } from "express";

/**
 * Middleware that validates the CONTROL_API_KEY on every request.
 *
 * Accepts the key via:
 *   - Authorization: Bearer <key>  (preferred — HTTPS only, not cached)
 *   - X-Api-Key: <key>
 *   - Cookie: magi_session=<key>   (set by the login form)
 *
 * Returns 401 JSON on failure so the UI can redirect to the login page.
 */
export function requireApiKey(
	req: Request,
	res: Response,
	next: NextFunction,
): void {
	const expectedKey = process.env.CONTROL_API_KEY;
	if (!expectedKey) {
		res.status(500).json({ error: "CONTROL_API_KEY not configured" });
		return;
	}

	const provided =
		extractBearer(req.headers.authorization) ??
		(req.headers["x-api-key"] as string | undefined) ??
		extractCookie(req.headers.cookie, "magi_session");

	if (!provided || provided !== expectedKey) {
		res.status(401).json({ error: "Unauthorized" });
		return;
	}

	next();
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
	const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
	return match?.[1];
}
