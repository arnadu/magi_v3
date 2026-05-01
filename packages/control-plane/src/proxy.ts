/**
 * Reverse proxy: routes operator browser traffic to an execution plane machine.
 *
 * Security (S2): the proxy target is always derived from the MongoDB missions
 * collection by missionId — never from user-supplied parameters. Requests to
 * non-existent or non-running missions return 404.
 */

import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { Router as createRouter } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import type { Db } from "mongodb";

interface MissionDoc {
	missionId: string;
	privateIp?: string;
	machineId?: string;
	status: string;
}

export function createProxyRouter(db: Db): Router {
	const router = createRouter();

	// Cache proxy instances by target URL — createProxyMiddleware registers
	// listeners on the HTTP server so it must NOT be called per-request.
	const proxyCache = new Map<string, RequestHandler>();

	function getProxy(target: string, missionId: string): RequestHandler {
		const key = target;
		if (!proxyCache.has(key)) {
			proxyCache.set(
				key,
				createProxyMiddleware({
					target,
					changeOrigin: true,
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
				}),
			);
		}
		return proxyCache.get(key)!;
	}

	// Proxy /missions/:id/dashboard/** and /missions/:id/events to the execution
	// plane machine's monitor server (port 4000).
	router.use(
		"/missions/:id",
		async (req: Request, res: Response, next: NextFunction) => {
			const missionId = req.params.id;

			// S2: resolve target from DB — never trust user input.
			const mission = await db
				.collection<MissionDoc>("missions")
				.findOne({ missionId });

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

			getProxy(target, missionId)(req, res, next);
		},
	);

	return router;
}
