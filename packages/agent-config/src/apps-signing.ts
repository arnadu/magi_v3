/**
 * The signed values of interactive apps (ADR-0037 decision 3), shared by the
 * control plane (which issues them) and the apps host (which checks them),
 * so the two cannot drift.
 *
 * - A **ticket**: issued by the control plane when the operator opens an
 *   app; valid 60 seconds, used once (its nonce), redeemed on the app's
 *   slot only.
 * - A **session**: the apps host's cookie, made from a redeemed ticket; at
 *   most 12 hours; bound to one app's capability and slot.
 * - The **apps token**: per mission, sent by the apps host to the monitor
 *   server's hop and injected into the mission machine as `APPS_TOKEN`.
 *
 * Tickets and sessions are `<base64url JSON>.<base64url HMAC-SHA256>`, the
 * `kind` inside the signed part, so neither can stand in for the other.
 * Keys come from the caller (APPS_TICKET_KEY, APPS_SIGNING_KEY); this module
 * reads no environment.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const APP_TICKET_TTL_MS = 60_000;
export const APP_SESSION_TTL_MS = 12 * 60 * 60_000;

/** What the apps host needs to reach one app for one user. */
export interface AppGrant {
	userId: string;
	missionId: string;
	app: string;
	/** The 32-hex capability in the app's path. */
	capability: string;
	/** The app's port on the apps host (its origin). */
	slot: number;
	/** The mission machine's private address, as the control plane knows it. */
	machine: string;
}

export interface AppTicket extends AppGrant {
	kind: "ticket";
	exp: number;
	nonce: string;
}

export interface AppSession extends AppGrant {
	kind: "session";
	exp: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (key: string, data: string) =>
	createHmac("sha256", key).update(data).digest("base64url");

function sign(value: AppTicket | AppSession, key: string): string {
	if (!key) throw new Error("no signing key for an app ticket or session");
	const body = b64(JSON.stringify(value));
	return `${body}.${mac(key, body)}`;
}

function verify(token: string, key: string): unknown {
	if (!key) return null;
	const [body, sig, extra] = token.split(".");
	if (!body || !sig || extra !== undefined) return null;
	const want = Buffer.from(mac(key, body));
	const got = Buffer.from(sig);
	if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
	try {
		return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
	} catch {
		return null;
	}
}

/** The grant and expiry of a verified value, built field by field; null when any is missing or malformed. */
function grantOf(
	v: Record<string, unknown>,
): (AppGrant & { exp: number }) | null {
	const { userId, missionId, app, capability, slot, machine, exp } = v;
	if (
		typeof userId !== "string" ||
		typeof missionId !== "string" ||
		typeof app !== "string" ||
		typeof capability !== "string" ||
		!/^[0-9a-f]{32}$/.test(capability) ||
		typeof slot !== "number" ||
		typeof machine !== "string" ||
		typeof exp !== "number"
	)
		return null;
	return { userId, missionId, app, capability, slot, machine, exp };
}

export function signAppTicket(
	grant: AppGrant,
	key: string,
	now = Date.now(),
): string {
	return sign(
		{
			...grant,
			kind: "ticket",
			exp: now + APP_TICKET_TTL_MS,
			nonce: b64(randomBytes(12)),
		},
		key,
	);
}

/** The ticket, or null when it is forged, expired, malformed or a session. */
export function verifyAppTicket(
	token: string,
	key: string,
	now = Date.now(),
): AppTicket | null {
	const v = verify(token, key) as Record<string, unknown> | null;
	const g = v && v.kind === "ticket" ? grantOf(v) : null;
	if (!g || typeof v?.nonce !== "string") return null;
	if (g.exp <= now || g.exp > now + APP_TICKET_TTL_MS) return null;
	return { ...g, kind: "ticket", nonce: v.nonce };
}

export function signAppSession(
	grant: AppGrant,
	key: string,
	now = Date.now(),
): string {
	return sign(
		{ ...grant, kind: "session", exp: now + APP_SESSION_TTL_MS },
		key,
	);
}

/** The session, or null when it is forged, expired, malformed or a ticket. */
export function verifyAppSession(
	token: string,
	key: string,
	now = Date.now(),
): AppSession | null {
	const v = verify(token, key) as Record<string, unknown> | null;
	const g = v && v.kind === "session" ? grantOf(v) : null;
	if (!g) return null;
	if (g.exp <= now || g.exp > now + APP_SESSION_TTL_MS) return null;
	return { ...g, kind: "session" };
}

/**
 * The per-mission apps token. Prefixed so it can never equal the monitor
 * token, even under the same key.
 */
export function deriveAppsToken(signingKey: string, missionId: string): string {
	if (!signingKey) return "";
	return createHmac("sha256", signingKey)
		.update(`apps:${missionId}`)
		.digest("hex");
}
