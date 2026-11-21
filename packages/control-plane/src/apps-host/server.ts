/**
 * The apps host (ADR-0037 decisions 1–4; component cp-apps): a separate Fly
 * app, on a different site from the cockpit, that serves every running app
 * on its own port (slot). It holds two keys and no other secret: it checks
 * the cockpit's tickets, keeps its own sessions, and forwards each app's
 * traffic to the mission machine's monitor server (`/a/<capability>/`) with
 * the per-mission apps token. Stateless but for the used tickets' nonces,
 * kept in memory: it runs one machine.
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
	APP_SESSION_TTL_MS,
	type AppSession,
	deriveAppsToken,
	type EntryTag,
	signAppSession,
	verifyAppSession,
	verifyAppTicket,
} from "@magi/agent-config";
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import {
	expectedOrigin,
	FRAME_POLICY,
	fetchSiteAllowed,
	isCapability,
	isNavigation,
	redeemPage,
	reopenUrl,
	rewriteSetCookies,
	SECURITY_HEADERS,
	sessionCookie,
	sessionCookies,
	setSecurityHeaders,
	slotOf,
	withoutSessionCookie,
} from "./policy.js";

const PROXY_TIMEOUT_MS = 10 * 60_000;

/**
 * The operation a route serves, read by the entry-point scan (as the control
 * plane's `operation()` in async-handler.ts, which this layer does not import).
 */
function operation(tag: EntryTag): express.RequestHandler {
	void tag;
	return (_req, _res, next) => next();
}

export interface AppsHostConfig {
	ticketKey: string;
	signingKey: string;
	cockpitUrl: string;
	onFly: boolean;
	/** The mission machines' monitor port (4000; a test sets its own). */
	monitorPort?: number;
	now?: () => number;
}

/** A request on its way to an app: the session that admitted it. */
type AppRequest = IncomingMessage & { appSession?: AppSession };

export function createAppsHost(config: AppsHostConfig) {
	const now = config.now ?? Date.now;
	const monitorPort = config.monitorPort ?? 4000;
	/** Used tickets' nonces → expiry, so each ticket opens once. */
	const usedNonces = new Map<string, number>();

	/** The session admitting a request to /a/<capability>/ on its slot, or why not. */
	function admit(
		req: IncomingMessage,
		capability: string,
	): AppSession | string {
		if (!isCapability(capability)) return "not an app";
		const slot = slotOf(req.headers, config.onFly);
		if (slot === null) return "not an app port";
		for (const token of sessionCookies(req.headers.cookie)) {
			const s = verifyAppSession(token, config.ticketKey, now());
			if (s && s.capability === capability && s.slot === slot) return s;
		}
		return "no session for this app";
	}

	const proxy = createAppProxy(
		config.signingKey,
		config.cockpitUrl,
		monitorPort,
	);

	function forward(
		req: express.Request,
		res: express.Response,
		next: express.NextFunction,
	): void {
		const capability = String(req.params.capability);
		const a = fetchSiteAllowed(req.headers)
			? admit(req, capability)
			: "a request from another site or app";
		if (typeof a === "string") {
			if (isNavigation(req.headers) && isCapability(capability))
				res.redirect(302, reopenUrl(config.cockpitUrl, capability));
			else res.status(403).type("text/plain").send(a);
			return;
		}
		(req as AppRequest).appSession = a;
		void proxy(req, res, next);
	}

	const app = express();
	app.disable("x-powered-by");
	app.get("/healthz", operation("infrastructure"), (_req, res) => {
		res.type("text/plain").send("ok");
	});
	app.get("/t/:ticket", operation("app.open"), (req, res) =>
		redeem(req, res, config, now, usedNonces),
	);
	app.all("/a/:capability", operation("app.open"), (req, res, next) =>
		forward(req, res, next),
	);
	app.all("/a/:capability/*", operation("app.open"), (req, res, next) =>
		forward(req, res, next),
	);
	app.use((_req, res) => {
		res.status(404).type("text/plain").send("not found");
	});

	/** WebSockets: the same session, and an Origin that is the slot's own. */
	function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
		const m = (req.url ?? "").match(/^\/a\/([^/?]+)/);
		const slot = slotOf(req.headers, config.onFly);
		const a =
			m &&
			slot !== null &&
			req.headers.origin === expectedOrigin(req.headers, slot, config.onFly)
				? admit(req, m[1])
				: "refused";
		if (typeof a === "string") {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
		(req as AppRequest).appSession = a;
		// An http.Server's upgrade socket is a net.Socket; Node types it as Duplex.
		proxy.upgrade(req as AppRequest, socket as Socket, head);
	}

	return {
		app,
		/** Attach the WebSocket handler to the listening server. */
		attach(server: Server): void {
			server.on("upgrade", upgrade);
		},
	};
}

/**
 * The proxy to mission machines' monitor servers: the apps token and mission
 * on the way in, the session cookie removed; on the way out, the app's
 * cookies rescoped, the security headers added, and a refused page load sent
 * back to the cockpit.
 */
function createAppProxy(
	signingKey: string,
	cockpitUrl: string,
	monitorPort: number,
) {
	const setHop = (
		pr: {
			setHeader(n: string, v: string): void;
			removeHeader(n: string): void;
		},
		req: AppRequest,
	) => {
		const s = req.appSession as AppSession;
		pr.setHeader("x-apps-token", deriveAppsToken(signingKey, s.missionId));
		pr.setHeader("x-apps-mission", s.missionId);
		pr.removeHeader("x-monitor-token");
		const cookie = withoutSessionCookie(req.headers.cookie);
		if (cookie) pr.setHeader("cookie", cookie);
		else pr.removeHeader("cookie");
	};

	return createProxyMiddleware<AppRequest, ServerResponse>({
		router: (req) => {
			const ip = (req.appSession as AppSession).machine;
			return `http://${ip.includes(":") ? `[${ip}]` : ip}:${monitorPort}`;
		},
		ws: false,
		proxyTimeout: PROXY_TIMEOUT_MS,
		on: {
			proxyReq: (pr, req) => setHop(pr, req),
			proxyReqWs: (pr, req) => setHop(pr, req as AppRequest),
			proxyRes: (pres, req) => {
				const s = req.appSession as AppSession;
				// The hop refused (no running app, a stale address, another mission):
				// a page load goes back to the cockpit for a fresh ticket.
				if (
					(pres.statusCode === 401 || pres.statusCode === 404) &&
					isNavigation(req.headers) &&
					pres.headers["content-type"]?.startsWith("text/plain")
				) {
					pres.statusCode = 302;
					pres.headers = {
						location: reopenUrl(cockpitUrl, s.capability),
					};
				}
				const sc = pres.headers["set-cookie"];
				if (sc)
					pres.headers["set-cookie"] = rewriteSetCookies(sc, s.capability);
				delete pres.headers["service-worker-allowed"];
				setSecurityHeaders(pres.headers);
				// Comma-separated CSP values are separate policies, each enforced.
				const csp = pres.headers["content-security-policy"];
				pres.headers["content-security-policy"] = csp
					? `${csp}, ${FRAME_POLICY}`
					: FRAME_POLICY;
			},
			error: (err, req, resOrSocket) => {
				const s = (req as AppRequest).appSession;
				console.error(
					`[apps-host] forwarding to mission ${s?.missionId} at ${s?.machine} failed: ${err.message}; the operator is sent back to the cockpit`,
				);
				if (!("writeHead" in resOrSocket)) return void resOrSocket.destroy();
				if (resOrSocket.headersSent) return void resOrSocket.end();
				if (s && isNavigation(req.headers))
					resOrSocket
						.writeHead(302, {
							location: reopenUrl(cockpitUrl, s.capability),
						})
						.end();
				else resOrSocket.writeHead(502).end();
			},
		},
	});
}

/**
 * Redeem a ticket: once, on its own slot, into a session for that app's
 * path. Answered with a page that moves to the app on the same site (a
 * Strict cookie set during a redirect chain that began on the cockpit's site
 * would not be sent), and storage cleared for whatever an earlier holder of
 * this slot left.
 */
function redeem(
	req: express.Request,
	res: express.Response,
	config: AppsHostConfig,
	now: () => number,
	usedNonces: Map<string, number>,
): void {
	const t = verifyAppTicket(String(req.params.ticket), config.ticketKey, now());
	const slot = slotOf(req.headers, config.onFly);
	for (const [n, exp] of usedNonces) if (exp <= now()) usedNonces.delete(n);
	if (!t || t.slot !== slot || usedNonces.has(t.nonce)) {
		res
			.status(403)
			.type("text/plain")
			.send(
				"This link has expired or was already used. Open the app again from the mission cockpit.",
			);
		return;
	}
	usedNonces.set(t.nonce, t.exp);
	const { kind: _k, exp: _e, nonce: _n, ...grant } = t;
	const session = signAppSession(grant, config.ticketKey, now());
	res.set({
		...SECURITY_HEADERS,
		"set-cookie": sessionCookie(
			session,
			t.capability,
			APP_SESSION_TTL_MS / 1000,
		),
		"clear-site-data": '"storage"',
		"content-security-policy": `default-src 'none'; ${FRAME_POLICY}`,
		"cache-control": "no-store",
	});
	res.status(200).type("html").send(redeemPage(t.capability));
}
