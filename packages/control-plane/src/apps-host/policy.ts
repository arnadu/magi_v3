/**
 * The apps host's rules for one request (ADR-0037 decisions 2 and 3), as
 * pure functions over headers so each can be tested without a network.
 *
 * Each app has its own origin: a port (a "slot") of the apps host. Cookies
 * ignore ports, so the session cookie is bound to its app's path and slot,
 * and requests coming from another app's port are refused.
 */

import type { IncomingHttpHeaders } from "node:http";

export const FIRST_SLOT = 20_000;
export const LAST_SLOT = 20_099;
export const SESSION_COOKIE = "magi_app";
const CAPABILITY = /^[0-9a-f]{32}$/;

/**
 * The slot (port) a request arrived on. On Fly, from `Fly-Forwarded-Port`,
 * which Fly overwrites; `X-Forwarded-Port` is passed through from the client
 * and never read. Locally, from the Host header. Null outside the range.
 */
export function slotOf(
	headers: IncomingHttpHeaders,
	onFly: boolean,
): number | null {
	const raw = onFly
		? headers["fly-forwarded-port"]
		: (headers.host ?? "").split(":").pop();
	const n = Number(Array.isArray(raw) ? raw[0] : raw);
	return Number.isInteger(n) && n >= FIRST_SLOT && n <= LAST_SLOT ? n : null;
}

export function isCapability(s: string): boolean {
	return CAPABILITY.test(s);
}

/**
 * Whether a request to an app's path may proceed. Ports of one host are one
 * *site*, so the browser sends cookies between them: a request started on
 * another app's port arrives `same-site`, and is refused. Only `same-origin`
 * (the app's own pages) and `none` (typed, bookmarked) are accepted. A
 * request without the header is refused: every supported browser sends it.
 */
export function fetchSiteAllowed(headers: IncomingHttpHeaders): boolean {
	const site = headers["sec-fetch-site"];
	return site === "same-origin" || site === "none";
}

/** True for a top-level page load, where a refusal should send the operator to the cockpit. */
export function isNavigation(headers: IncomingHttpHeaders): boolean {
	return headers["sec-fetch-mode"] === "navigate";
}

/** Every value of the session cookie in the request (an app could plant a decoy beside the real one). */
export function sessionCookies(cookieHeader: string | undefined): string[] {
	if (!cookieHeader) return [];
	const out: string[] = [];
	for (const part of cookieHeader.split(";")) {
		const i = part.indexOf("=");
		if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE)
			out.push(part.slice(i + 1).trim());
	}
	return out;
}

/** The Cookie header without the session cookie: the app (agent code) never sees it. */
export function withoutSessionCookie(
	cookieHeader: string | undefined,
): string | undefined {
	if (!cookieHeader) return undefined;
	const kept = cookieHeader
		.split(";")
		.map((p) => p.trim())
		.filter((p) => p && p.split("=")[0].trim() !== SESSION_COOKIE);
	return kept.length ? kept.join("; ") : undefined;
}

export function sessionCookie(
	token: string,
	capability: string,
	maxAgeS: number,
): string {
	return `${SESSION_COOKIE}=${token}; Path=/a/${capability}/; Max-Age=${maxAgeS}; HttpOnly; Secure; SameSite=Strict`;
}

/**
 * An app's own cookies, scoped to its path and host: `Path` replaced, `Domain`
 * removed, and any cookie named like the session dropped.
 */
export function rewriteSetCookies(
	values: string[],
	capability: string,
): string[] {
	return values
		.filter((c) => c.split("=")[0].trim() !== SESSION_COOKIE)
		.map((c) => {
			const parts = c
				.split(";")
				.map((p) => p.trim())
				.filter((p) => !/^(path|domain)=/i.test(p));
			return [...parts, `Path=/a/${capability}/`].join("; ");
		});
}

/** Headers set on every response of the apps host, whatever the app sends. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"referrer-policy": "no-referrer",
	"cross-origin-opener-policy": "same-origin",
	"x-content-type-options": "nosniff",
	"cross-origin-resource-policy": "same-origin",
};
/** Added beside any CSP the app sends (each policy is enforced). */
export const FRAME_POLICY = "frame-ancestors 'none'";

/** Where a refused navigation goes: the cockpit, which signs the operator in and issues a new ticket. */
export function reopenUrl(cockpitUrl: string, capability: string): string {
	return `${cockpitUrl.replace(/\/$/, "")}/?openApp=${capability}`;
}

/** The origin a WebSocket from the app's own pages carries. */
export function expectedOrigin(
	headers: IncomingHttpHeaders,
	slot: number,
	onFly: boolean,
): string {
	const host = (headers.host ?? "").split(":")[0];
	return `${onFly ? "https" : "http"}://${host}:${slot}`;
}

/** The page that redeems a ticket: sets the session, then moves to the app on the same site. */
export function redeemPage(capability: string): string {
	return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/a/${capability}/"><title>Opening…</title><p>Opening the app…</p>`;
}
