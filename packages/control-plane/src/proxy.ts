/**
 * Reverse proxy: routes operator browser traffic to an execution plane machine.
 *
 * Security (S2): the proxy target is always derived from the MongoDB missions
 * collection by missionId — never from user-supplied parameters. Requests to
 * non-existent or non-running missions return 404.
 */

import { storedCollection } from "@magi/agent-config";
import type {
	NextFunction,
	Request,
	RequestHandler,
	Response,
	Router,
} from "express";
import { Router as createRouter } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import type { Db } from "mongodb";
import { asyncRoutes } from "./async-handler.js";
import { deriveMonitorToken } from "./monitor-token.js";

export function createProxyRouter(db: Db): Router {
	const router = createRouter();
	const routes = asyncRoutes(router);

	// Cache proxy instances — createProxyMiddleware registers listeners on the
	// HTTP server so it must NOT be called per-request. Keyed by mission and
	// target, not target alone: each instance's pathRewrite holds its mission
	// id, and Fly can hand a released private address to another mission (PX1).
	const proxyCache = new Map<string, RequestHandler>();

	function getProxy(target: string, missionId: string): RequestHandler {
		const key = `${missionId} ${target}`;
		let proxy = proxyCache.get(key);
		if (!proxy) {
			proxy = createProxyMiddleware({
				target,
				changeOrigin: true,
				// Without these, a stale privateIp (machine restarted/crashed,
				// Mongo not yet reconciled) or a genuinely wedged backend hangs the
				// browser request indefinitely instead of failing fast — this was
				// part of what surfaced as "the cockpit times out". proxyTimeout
				// bounds the upstream connect+response; timeout bounds the
				// inbound socket. The mission's own SSE stream (long-lived by
				// design, keeps itself alive via monitor-server.ts's heartbeat) is
				// unaffected — these are per-request/per-connection idle bounds,
				// not a cap on total connection lifetime.
				proxyTimeout: 30_000,
				timeout: 30_000,
				pathRewrite: (path) => path.replace(`/missions/${missionId}`, ""),
				on: {
					error: (err, _req, proxyRes) => {
						console.error(
							`[proxy] Error forwarding to ${target}: ${(err as Error).message}`,
						);
						if (
							"headersSent" in proxyRes &&
							!(proxyRes as Response).headersSent
						) {
							(proxyRes as Response)
								.status(502)
								.json({ error: "Upstream unavailable" });
						}
					},
				},
			});
			proxyCache.set(key, proxy);
		}
		return proxy;
	}

	// Proxy /missions/:id/** — the monitor server's JSON, SSE and file routes the
	// cockpit calls (`/events`, `/status`, `/files/*`, `/download`, …) — to the
	// execution plane machine's port 4000. The monitor serves no HTML of its own
	// since the legacy dashboard was deleted (F-052); the cockpit is the only UI.
	routes.use(
		"/missions/:id",
		async (req: Request, res: Response, next: NextFunction) => {
			const missionId = req.params.id;

			// S2: resolve target from DB — never trust user input.
			// S9 (F-019): scope lookup to the requesting user so a user cannot proxy
			// into another user's mission. Admins bypass the filter.
			const ownerFilter = req.isAdmin ? {} : { userId: req.userId };
			const mission = await storedCollection(db, "missions").findOne({
				missionId,
				...ownerFilter,
			});

			if (!mission || !mission.privateIp) {
				res.status(404).json({ error: "Mission not found" });
				return;
			}

			if (mission.status !== "running") {
				res
					.status(503)
					.json({ error: "Mission is not running", status: mission.status });
				return;
			}

			// Forward to internal machine. IPv6 addresses need brackets in URLs.
			const ip = mission.privateIp.includes(":")
				? `[${mission.privateIp}]`
				: mission.privateIp;
			const target = `http://${ip}:4000`;

			// Inject per-mission auth token so MonitorServer can verify the request
			// came through the authenticated proxy. Derived from MONITOR_SIGNING_KEY
			// (control plane env only) — never stored in MongoDB.
			const monitorToken = deriveMonitorToken(missionId);
			if (monitorToken) req.headers["x-monitor-token"] = monitorToken;

			getProxy(target, missionId)(req, res, next);
		},
	);

	return router;
}
