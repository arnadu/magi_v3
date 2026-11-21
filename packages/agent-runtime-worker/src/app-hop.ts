/**
 * The hop from the monitor server to an app (ADR-0037 decision 4): requests
 * under `/a/<capability>/` from the apps host, forwarded to the app's
 * loopback port, HTTP and WebSocket upgrades alike.
 *
 * Its own authentication, checked before the monitor's: the apps token (the
 * monitor token does not open apps, and the apps token opens nothing else),
 * the mission named by the apps host equal to this machine's, and a
 * capability of a running app. The two hop headers are removed before the
 * request reaches the app, so the token never reaches an agent's code.
 *
 * One upgrade handler per server and `ws: false` on every proxy: with
 * `ws: true`, http-proxy-middleware subscribes each instance to the server's
 * upgrade event after its first request, so several apps answered one
 * WebSocket (spike, 2026-11-21). The URL is rewritten here, not with
 * `pathRewrite`, which the library did not apply to upgrades.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { EntryTag } from "@magi/agent-config";
import { createProxyMiddleware } from "http-proxy-middleware";
import type { AppRoute } from "./app-supervisor.js";
import { safeEqual } from "./safe-equal.js";

const HOP_PATH = /^\/a\/([0-9a-f]{32})(\/|$)/;
const TOKEN_HEADER = "x-apps-token";
const MISSION_HEADER = "x-apps-mission";
/** Idle bound on a forwarded request; a notebook's WebSocket is kept alive by its own traffic. */
const PROXY_TIMEOUT_MS = 10 * 60_000;

export interface AppHopDeps {
	missionId: string;
	/**
	 * `APPS_TOKEN` (`appsTokenFromEnv`): a string; "" for a local developer
	 * daemon (no check); null on Fly without one, when every request is refused.
	 */
	appsToken: string | null;
	route(capability: string): (AppRoute & { name: string }) | undefined;
	/** The app was used: resets its idle clock. */
	touch(name: string): void;
}

export interface AppHop {
	/** True for a path this hop serves; the monitor then hands the request over. */
	owns(url: string): boolean;
	http(req: IncomingMessage, res: ServerResponse): void;
	upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

/**
 * The apps token from the environment. On Fly a machine created before the
 * control plane injected one has none: the hop then refuses every request
 * (null) rather than stopping the daemon from booting.
 */
export function appsTokenFromEnv(env = process.env): string | null {
	const token = env.APPS_TOKEN ?? "";
	if (!token && env.FLY_APP_NAME) {
		console.error(
			"[apps] APPS_TOKEN is empty on a Fly machine: no app can be opened until the mission restarts on a machine created with one",
		);
		return null;
	}
	return token;
}

type Proxy = ReturnType<typeof createProxyMiddleware>;

export function createAppHop(deps: AppHopDeps): AppHop {
	const proxies = new Map<string, Proxy>();

	function proxyFor(r: AppRoute): Proxy {
		const key = `${r.port} ${r.jupyterToken ?? ""}`;
		let p = proxies.get(key);
		if (!p) {
			const prepare = (pr: {
				removeHeader(n: string): void;
				setHeader(n: string, v: string): void;
			}) => {
				pr.removeHeader(TOKEN_HEADER);
				pr.removeHeader(MISSION_HEADER);
				if (r.jupyterToken)
					pr.setHeader("authorization", `token ${r.jupyterToken}`);
			};
			p = createProxyMiddleware({
				target: `http://127.0.0.1:${r.port}`,
				ws: false,
				proxyTimeout: PROXY_TIMEOUT_MS,
				on: {
					proxyReq: prepare,
					proxyReqWs: prepare,
					error: (err, _req, resOrSocket) => {
						console.error(
							`[apps] forwarding to the app on port ${r.port} failed: ${err.message}`,
						);
						if ("writeHead" in resOrSocket && !resOrSocket.headersSent)
							resOrSocket.writeHead(502).end();
						else resOrSocket.destroy();
					},
				},
			});
			// A port's app changes when it restarts; keep only the current ones.
			for (const k of proxies.keys())
				if (k.startsWith(`${r.port} `)) proxies.delete(k);
			proxies.set(key, p);
		}
		return p;
	}

	/** The app this request may reach, or why not. */
	function admit(
		req: IncomingMessage,
	): { route: AppRoute & { name: string }; capability: string } | string {
		const m = (req.url ?? "").match(HOP_PATH);
		if (!m) return "not an app path";
		if (deps.appsToken === null) return "unauthorized";
		if (deps.appsToken) {
			const t = req.headers[TOKEN_HEADER];
			if (typeof t !== "string" || !safeEqual(t, deps.appsToken))
				return "unauthorized";
		}
		if (req.headers[MISSION_HEADER] !== deps.missionId)
			return "another mission";
		const route = deps.route(m[1]);
		if (!route) return "no running app";
		return { route, capability: m[1] };
	}

	/** The URL as the app expects it: JupyterLab serves under its base URL, the others at `/`. */
	function rewrite(req: IncomingMessage, r: AppRoute, capability: string) {
		if (r.keepPrefix) return;
		const rest = (req.url ?? "").slice(`/a/${capability}`.length);
		req.url = rest.startsWith("/") ? rest : `/${rest}`;
	}

	function http(req: IncomingMessage, res: ServerResponse): void {
		const a = admit(req);
		if (typeof a === "string") {
			// The apps host turns any refusal into "open it again from the cockpit".
			res.writeHead(a === "unauthorized" ? 401 : 404, {
				"Content-Type": "text/plain",
			});
			res.end(a);
			return;
		}
		deps.touch(a.route.name);
		rewrite(req, a.route, a.capability);
		void proxyFor(a.route)(req, res, () => {
			if (!res.headersSent) res.writeHead(502).end();
		});
	}

	/**
	 * The hop as an entry point, in the route table's shape so the trace finds
	 * it: it serves the operator's use of an app (app.open). It runs before
	 * that table, with its own authentication.
	 */
	const entry: {
		method: string;
		path: RegExp;
		operation: EntryTag;
		handler: typeof http;
	} = { method: "*", path: HOP_PATH, operation: "app.open", handler: http };

	return {
		owns: (url) => url.startsWith("/a/"),
		http: entry.handler,
		upgrade(req, socket, head) {
			const a = admit(req);
			if (typeof a === "string") {
				socket.end(
					`HTTP/1.1 ${a === "unauthorized" ? "401 Unauthorized" : "404 Not Found"}\r\nConnection: close\r\n\r\n`,
				);
				return;
			}
			deps.touch(a.route.name);
			rewrite(req, a.route, a.capability);
			// An http.Server's upgrade socket is a net.Socket; Node types it as Duplex.
			proxyFor(a.route).upgrade(req, socket as Socket, head);
		},
	};
}
